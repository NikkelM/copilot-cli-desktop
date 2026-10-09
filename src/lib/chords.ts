/**
 * Key presses as something that can be written down, compared and changed (#246).
 *
 * The shortcuts were hand-written conditions - `event.key === 'b' && event.ctrlKey` and so
 * on - which cannot be rebound, because the key is in the code rather than in a value. A
 * chord is the same press as data: the modifiers, and one token for the key itself.
 *
 * Letters and digits come from `event.code`, so a chord means the same physical key on every
 * layout: shift turns `m` into `M`, and an AZERTY keyboard puts `a` where `q` is. Punctuation
 * goes the other way and comes from `event.key`, because there the character is the point and
 * which key carries it differs by layout - `?` is shift and the slash key here, and somewhere
 * else entirely on a German keyboard.
 */

/** A press, as the help list writes it and as an event can be compared against it. */
export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** The key itself, lower case: a letter, a digit, or one of the names below. */
  key: string;
}

/**
 * The keys that are a key rather than a character, by the `code` they arrive as.
 *
 * Shift means something here - shift+f6 is not f6 - which is what separates them from the
 * punctuation below, where shift is only how the character was produced.
 */
const NAMED: Record<string, string> = {
  Escape: 'esc',
  Tab: 'tab',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Space: 'space',
  Backspace: 'backspace',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ContextMenu: 'menu',
};

/** The modifiers, in the order they are written, so one chord has one spelling. */
const ORDER = ['ctrl', 'shift', 'alt'] as const;

/**
 * The characters that are one key under another name.
 *
 * `plus` is written as a word because `+` is itself the separator, and it has to answer
 * three keys: the main row with shift, the same key without - which is what every browser
 * and editor accepts for zooming in - and the keypad.
 */
const SAME: Record<string, string> = {
  '+': 'plus',
  '=': 'plus',
  '-': 'minus',
  _: 'minus',
};

/** The names a key may go by, which is what keeps `ctrl+wheel` from reading as a chord. */
const KEYS = new Set([...Object.values(NAMED), 'plus', 'minus']);

/** Whether a word names a key at all. A single character always does; a word must be known. */
function isKey(token: string): boolean {
  return token.length === 1 || /^f([1-9]|1[0-2])$/.test(token) || KEYS.has(token);
}

/**
 * Whether shift is part of this key or only how its character was produced.
 *
 * `?` is shift and another key, so a chord asking for `?` has to answer a press with shift
 * held. `shift+f6` is a different key from `f6` and must not.
 */
function loose(token: string): boolean {
  return !/^[a-z0-9]$/.test(token) && !/^f([1-9]|1[0-2])$/.test(token) && !Object.values(NAMED).includes(token);
}

/**
 * The key a press is about, or null for a press that is only modifiers.
 *
 * Holding Ctrl on its own raises a keydown whose key is `Control`, and a chord cannot be made
 * of nothing - which is what stops the capture in the settings window recording one.
 */
export function tokenOf(event: Pick<KeyboardEvent, 'code' | 'key'>): string | null {
  const code = event.code;

  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^(Digit|Numpad)[0-9]$/.test(code)) return code.slice(-1);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  if (code in NAMED) return NAMED[code]!;
  // The keypad has no character worth reading, so these two are named by their key after all.
  if (code === 'NumpadAdd') return 'plus';
  if (code === 'NumpadSubtract') return 'minus';

  const key = event.key;
  if (!key || key === 'Unidentified') return null;

  if (key.length === 1) {
    const token = key.toLowerCase();
    return SAME[token] ?? token;
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) return key.toLowerCase();
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(key)) return null;

  return key.toLowerCase();
}

/** The chord a press makes, or null when nothing but modifiers were held. */
export function chordOf(
  event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): Chord | null {
  const key = tokenOf(event);
  if (key === null) return null;

  // Recorded as not held when shift is only how the character came out, so capturing `?`
  // writes down `?` rather than `shift+?` - which would then match nothing at all.
  return { ctrl: event.ctrlKey, shift: event.shiftKey && !loose(key), alt: event.altKey, key };
}

/** A chord as one string, which is what is written down and shown to a reader. */
export function writeChord(chord: Chord): string {
  const held = ORDER.filter((name) => chord[name]);
  return [...held, chord.key].join('+');
}

/**
 * A chord read back from what was written.
 *
 * Returns null for anything this cannot make sense of, which is what keeps a hand-edited
 * settings file from silently binding something nobody meant. `esc esc` and `ctrl+wheel` are
 * among those: a double press and a wheel are not chords, and the keys that use them say so
 * rather than pretending to be rebindable.
 */
export function parseChord(text: string): Chord | null {
  const parts = text
    .trim()
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const chord: Chord = { ctrl: false, shift: false, alt: false, key: '' };

  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (!last && (part === 'ctrl' || part === 'shift' || part === 'alt')) {
      chord[part] = true;
      continue;
    }
    // A modifier in the last place is a chord with no key, anything before the last place
    // that is not a modifier is two keys at once, and a word that names no key is not one.
    if (!last || !isKey(part)) return null;
    chord.key = SAME[part] ?? part;
  }

  if (!chord.key) return null;
  if (loose(chord.key)) chord.shift = false;
  return chord;
}

/** Whether two chords are the same press, which is what makes one of them unassignable. */
export function sameChord(one: Chord, other: Chord): boolean {
  return one.key === other.key && one.ctrl === other.ctrl && one.shift === other.shift && one.alt === other.alt;
}

/** Whether a press is this chord. */
export function matchesChord(
  chord: Chord,
  event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): boolean {
  const pressed = chordOf(event);
  return pressed !== null && sameChord(pressed, chord);
}

/**
 * Whether a chord has nothing to stop it being typed.
 *
 * These fire wherever the keyboard happens to be, including inside the message box, so a
 * chord with no modifier would take a letter away from whoever is writing with it. Function
 * keys are the exception, since they type nothing to begin with.
 */
export function needsModifier(chord: Chord): boolean {
  return !chord.ctrl && !chord.alt && !/^f([1-9]|1[0-2])$/.test(chord.key);
}
