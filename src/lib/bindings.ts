import { needsModifier, parseChord, sameChord, writeChord, type Chord } from './chords';

export type Shortcut =
  | 'interrupt'
  | 'escape-twice'
  | 'help'
  | 'reasoning'
  | 'stash'
  | 'larger'
  | 'smaller'
  | 'reset-size'
  | 'sidebar'
  | 'new-session'
  | 'find-session'
  | 'go-sessions'
  | 'go-composer'
  | 'wiki'
  | 'import'
  | 'next-region'
  | 'previous-region'
  | 'cycle-mode'
  | 'attach';

export interface Binding {
  /**
   * Set when the app is what implements the key, which is also what makes it changeable.
   *
   * Absent for the ones the CLI's own readline provides and for plain text editing, which
   * this app passes through rather than implements. The reader does not care which part of
   * the app answers a key, so the list covers all of them - but only the ones with an id
   * can be reported, or rebound.
   */
  id?: Shortcut;
  /** As a reader would press it, for the list they can call up. */
  keys: string;
  what: string;
}

/**
 * Every key worth telling someone about, in one list.
 *
 * The list the reader sees is built from this rather than written beside it, so a key cannot
 * be described here without working. Unlike the CLI there is no status line to put a hint
 * in, which makes the list the only way to find them.
 *
 * Two things are deliberately absent. Ordinary text editing, because a text box already has
 * what this platform uses - the CLI documents ctrl+a and ctrl+e only for want of a terminal
 * that provides them. And plain navigation - Tab, a single Escape - which is what a list on
 * screen already invites; a reference that spends its rows on them buries the keys nothing
 * else would reveal.
 *
 * The arrows are listed even so, because stepping through history is not what an arrow does
 * anywhere else, and ctrl+u and ctrl+k because readline gives them and a textarea does not.
 *
 * Worded and ordered as the CLI words and orders its own, down to the lower case, so the two
 * read as one tool.
 */
export const BINDINGS: readonly Binding[] = [
  { keys: '/help', what: 'show full help' },
  { id: 'help', keys: '?', what: 'show the shortcuts' },
  { keys: '/', what: 'commands' },
  { id: 'interrupt', keys: 'ctrl+c', what: 'stop the turn' },
  { id: 'escape-twice', keys: 'esc esc', what: 'clear the message or stop the turn' },
  { id: 'reasoning', keys: 'ctrl+t', what: 'show or hide reasoning' },
  { id: 'stash', keys: 'ctrl+s', what: 'stash or restore the message' },
  { id: 'larger', keys: 'ctrl+plus', what: 'zoom in' },
  { id: 'smaller', keys: 'ctrl+minus', what: 'zoom out' },
  { id: 'reset-size', keys: 'ctrl+0', what: 'reset the zoom' },
  { id: 'sidebar', keys: 'ctrl+b', what: 'show or hide the sidebar' },
  { id: 'new-session', keys: 'ctrl+n', what: 'new session' },
  { id: 'find-session', keys: 'ctrl+shift+p', what: 'find a session' },
  { id: 'go-sessions', keys: 'ctrl+shift+s', what: 'go to the session list' },
  { id: 'go-composer', keys: 'ctrl+shift+m', what: 'go to the message box' },
  { id: 'wiki', keys: 'ctrl+shift+k', what: 'open the wiki' },
  { id: 'import', keys: 'ctrl+shift+o', what: 'import a session' },
  { id: 'next-region', keys: 'f6', what: 'next part of the window' },
  { id: 'previous-region', keys: 'shift+f6', what: 'previous part of the window' },
  { keys: 'ctrl+wheel', what: 'zoom in or out' },
  /*
   * The CLI asks for this with shift+tab, which here would mean giving up the one key that
   * walks backwards out of the composer. The CLI has a prompt to leave; this has a window to
   * walk, and taking the key back is worth more than matching it.
   */
  { id: 'cycle-mode', keys: 'alt+m', what: 'switch mode' },
  { id: 'attach', keys: 'ctrl+shift+a', what: 'attach files' },
  { keys: 'shift+enter', what: 'insert newline' },
  { keys: 'up/down', what: 'previous or next prompt' },
  { keys: 'ctrl+r', what: 'reverse search history' },
  { keys: 'alt+left', what: 'back a page in the wiki' },
  { keys: 'ctrl+u', what: 'delete to start of line' },
  { keys: 'ctrl+k', what: 'delete to end of line' },
];

/**
 * What a reader changed, by the key it changed.
 *
 * An id missing from this is on its default. An id present with nothing against it was
 * cleared on purpose, which is not the same thing: one means "whatever the app chose" and
 * the other means "I do not want this key".
 */
export type Overrides = Partial<Record<Shortcut, string>>;

/**
 * Whether a key can be changed at all.
 *
 * Two kinds cannot. The ones the app does not implement - readline's keys, text editing, the
 * slash commands - because there is nothing here to rebind. And `esc esc`, which is a press
 * repeated rather than a press with modifiers, and so is not a chord to begin with.
 */
export function canRebind(binding: Binding): boolean {
  return binding.id !== undefined && parseChord(binding.keys) !== null;
}

/** The bindings a reader may change, in the order the list has them. */
export const REBINDABLE: readonly Binding[] = BINDINGS.filter(canRebind);

/**
 * What was changed, read back from the settings file.
 *
 * Anything unrecognised is dropped rather than carried: a key from a later version, or a
 * chord a hand edit got wrong, should leave that shortcut on its default rather than break
 * the whole set.
 */
export function readOverrides(stored: string): Overrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored || '{}');
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const known = new Set(REBINDABLE.map((binding) => binding.id));
  const found: Overrides = {};

  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(id as Shortcut) || typeof value !== 'string') continue;
    // Empty is the one string that is not a chord and still means something: cleared.
    if (value !== '' && parseChord(value) === null) continue;
    found[id as Shortcut] = value;
  }

  return found;
}

/** What was changed, as the settings file holds it. */
export function writeOverrides(overrides: Overrides): string {
  return JSON.stringify(overrides);
}

/**
 * The bindings as they actually are, with what the reader changed applied.
 *
 * A cleared key keeps its row - the reader is told what it would do if they gave it one -
 * but with nothing in the keys column, and nothing answers it.
 */
export function resolveBindings(overrides: Overrides): Binding[] {
  return BINDINGS.map((binding) => {
    const changed = binding.id === undefined ? undefined : overrides[binding.id];
    return changed === undefined ? binding : { ...binding, keys: changed };
  });
}

/** The chord each key answers to, leaving out the ones that are cleared or are not chords. */
export function chordsOf(overrides: Overrides): Map<Shortcut, Chord> {
  const chords = new Map<Shortcut, Chord>();

  for (const binding of resolveBindings(overrides)) {
    if (binding.id === undefined) continue;
    const chord = parseChord(binding.keys);
    if (chord) chords.set(binding.id, chord);
  }

  return chords;
}

/** Why a chord cannot be given to a key, or null when it can. */
export type Refusal = { why: 'unmodified' } | { why: 'taken'; by: Binding };

/**
 * Whether a chord is free, and what has it when it is not (#246).
 *
 * Refusing is the whole of the answer: the reader is told what already holds the key and
 * keeps the one they had. Quietly taking it from whatever had it would leave them with a
 * shortcut that stopped working and no way to find out why.
 *
 * Everything in the list is checked, not only the keys this app implements, because the
 * composer passes the rest to the CLI's readline - binding ctrl+u to the sidebar would
 * silently cost them "delete to start of line".
 */
export function refuse(id: Shortcut, chord: Chord, overrides: Overrides): Refusal | null {
  if (needsModifier(chord)) return { why: 'unmodified' };

  for (const binding of resolveBindings(overrides)) {
    if (binding.id === id) continue;
    const held = parseChord(binding.keys);
    if (held && sameChord(held, chord)) return { why: 'taken', by: binding };
  }

  return null;
}

/** A chord given to a key, or the reason it cannot be. */
export function bind(id: Shortcut, chord: Chord, overrides: Overrides): Overrides | Refusal {
  const refusal = refuse(id, chord, overrides);
  if (refusal) return refusal;

  return { ...overrides, [id]: writeChord(chord) };
}

/** Whether what came back from `bind` is a refusal rather than a new set. */
export function refused(result: Overrides | Refusal): result is Refusal {
  return 'why' in result;
}
