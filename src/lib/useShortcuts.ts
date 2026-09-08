import { useEffect, useRef } from 'react';

/** How long a second Escape still counts as part of the first. */
const DOUBLE_ESCAPE_MS = 800;

export type Shortcut = 'interrupt' | 'escape-twice' | 'help';

export interface Binding {
  /**
   * Set when this hook is what implements the key.
   *
   * Absent for the ones the composer or the menu owns. The reader does not care which part
   * of the app answers a key, so the list covers all of them - but only this hook's can be
   * held to reporting a `Shortcut`.
   */
  id?: Shortcut;
  /** As a reader would press it, for the list they can call up. */
  keys: string;
  what: string;
}

/**
 * Every key the app answers, in one list.
 *
 * The list the reader sees is built from this rather than written beside it, so a key cannot
 * be described here without working. Unlike the CLI there is no status line to put a hint
 * in, which makes the list the only way to find them.
 *
 * Ordinary text editing is left out. The CLI documents ctrl+a, ctrl+e, ctrl+k and the rest
 * because a terminal gives none of them for free; a text box already has the ones this
 * platform uses, and listing them would be documenting the operating system.
 */
export const BINDINGS: readonly Binding[] = [
  { id: 'help', keys: '?', what: 'Show these shortcuts' },
  { keys: '/', what: 'Run a command rather than send a message' },
  { keys: 'Enter', what: 'Send, or queue behind the turn already running' },
  { keys: 'Shift+Enter', what: 'Start a new line' },
  { keys: '↑ ↓', what: 'Move through the menu' },
  { keys: 'Tab', what: 'Complete the highlighted command without running it' },
  { keys: 'Esc', what: 'Close the menu' },
  { id: 'interrupt', keys: 'Ctrl+C', what: 'Stop the turn' },
  { id: 'escape-twice', keys: 'Esc Esc', what: 'Stop the turn, or clear what is written' },
];

/** Whether a key press belongs to whatever is being typed into. */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;

  return (
    element.isContentEditable ||
    // The attribute as well as the property: text inside an editable region is being typed
    // into even though the element receiving the key is not itself the editable one.
    Boolean(element.closest?.('[contenteditable=""], [contenteditable="true"]')) ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  );
}

/**
 * Whether nothing has been written yet, so a key pressed now is the first character.
 *
 * The composer holds the keyboard whenever a session is open, so a shortcut that refuses to
 * fire while a field has focus would be unreachable almost all of the time. A question mark
 * as the first character is a question nobody asks, which is what makes it safe to claim -
 * the same reasoning the CLI applies to its own leading keys.
 *
 * The caller is asked before the field itself, because the caller holds the text and the
 * field is only where it is being shown.
 */
function nothingWritten(target: EventTarget | null, writing?: () => string): boolean {
  if (writing) return writing().length === 0;

  const field = target as HTMLInputElement | HTMLTextAreaElement | null;
  // A menu has a value but nothing is being typed into it, so it is never "the first
  // character" of anything.
  if (field?.tagName !== 'INPUT' && field?.tagName !== 'TEXTAREA') return false;

  return field.value.length === 0;
}

/**
 * The keys a terminal reflex expects to work.
 *
 * This app replaces a terminal, and the muscle memory comes with the reader: reaching for
 * the mouse to stop a turn is the moment they notice they have left the terminal behind.
 * Bound on the window rather than on a component, so they work wherever the focus happens
 * to be - including inside the composer for the ones that make sense there.
 *
 * @param writing what has been typed but not sent, since the app knows that better than the
 *   field does: a shortcut that has to sniff the DOM for it is guessing.
 */
export function useShortcuts(on: (shortcut: Shortcut) => void, writing?: () => string) {
  // Held in refs so a caller passing a fresh function does not re-register the listener,
  // and so the double-press window survives a render.
  const handler = useRef(on);
  handler.current = on;
  const written = useRef(writing);
  written.current = writing;
  const lastEscape = useRef(0);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A prompt or a menu that is open owns Escape: dismissing it is what the reader
      // means, not stopping the turn behind it.
      if (event.defaultPrevented) return;

      if (event.key === 'Escape') {
        const now = Date.now();
        const again = now - lastEscape.current < DOUBLE_ESCAPE_MS;
        lastEscape.current = again ? 0 : now;

        // One Escape is how a menu closes and how a field is left, so only the second does
        // anything: the same layering the CLI uses.
        if (again) handler.current('escape-twice');
        return;
      }

      if (event.key === 'c' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        // Ctrl+C is copy first. Taking it from a reader with something selected would lose
        // them the thing they were copying, which is worse than making them press Stop.
        if (!window.getSelection()?.toString()) {
          event.preventDefault();
          handler.current('interrupt');
        }
        return;
      }

      // The composer holds the keyboard whenever a session is open, so refusing to fire
      // while a field has focus would put this out of reach almost all of the time. A
      // question mark as the first character of a message is one nobody types, so it is
      // claimed - and swallowed, rather than left in the box behind the list.
      if (event.key === '?' && (!typing(event.target) || nothingWritten(event.target, written.current))) {
        event.preventDefault();
        handler.current('help');
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
