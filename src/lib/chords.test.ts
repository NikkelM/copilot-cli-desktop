// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { chordOf, matchesChord, needsModifier, parseChord, tokenOf, writeChord } from './chords';

/** A press, as the browser describes one. */
const press = (over: Partial<KeyboardEvent> = {}) =>
  ({ code: '', key: '', ctrlKey: false, shiftKey: false, altKey: false, ...over }) as KeyboardEvent;

describe('the key a press is about', () => {
  it.each([
    ['KeyM', 'm'],
    ['KeyA', 'a'],
    ['Digit0', '0'],
    ['Numpad7', '7'],
    ['F6', 'f6'],
    ['F12', 'f12'],
    ['Escape', 'esc'],
    ['ArrowUp', 'up'],
    ['ContextMenu', 'menu'],
    ['NumpadAdd', 'plus'],
    ['Minus', 'minus'],
    ['Slash', '?'],
  ])('reads %s as %s', (code, token) => {
    expect(tokenOf(press({ code, key: code === 'Minus' ? '-' : code === 'Slash' ? '?' : '' }))).toBe(token);
  });

  /**
   * Read from the code, so a chord means the same key wherever it is pressed. Shift turns
   * `m` into `M`, and an AZERTY keyboard puts `a` where `q` is.
   */
  it('is the same key however the character comes out', () => {
    expect(tokenOf(press({ code: 'KeyM', key: 'M' }))).toBe('m');
    expect(tokenOf(press({ code: 'KeyQ', key: 'a' })), 'the key under the finger').toBe('q');
  });

  /** A press with no code is what a synthesised event gives, and some layouts too. */
  it('falls back to the character when there is no code worth having', () => {
    expect(tokenOf(press({ key: 'b' }))).toBe('b');
    expect(tokenOf(press({ key: 'F6' }))).toBe('f6');
  });

  it.each(['Control', 'Shift', 'Alt', 'Meta'])('is nothing for %s on its own', (key) => {
    expect(tokenOf(press({ key })), 'a chord cannot be made of modifiers').toBeNull();
  });

  it('is nothing for a press the browser could not name', () => {
    expect(tokenOf(press({ key: 'Unidentified' }))).toBeNull();
  });
});

describe('writing a chord down', () => {
  it.each([
    [{ ctrl: true, shift: false, alt: false, key: 'b' }, 'ctrl+b'],
    [{ ctrl: true, shift: true, alt: false, key: 'p' }, 'ctrl+shift+p'],
    [{ ctrl: false, shift: false, alt: true, key: 'm' }, 'alt+m'],
    [{ ctrl: false, shift: false, alt: false, key: 'f6' }, 'f6'],
    [{ ctrl: false, shift: true, alt: false, key: 'f6' }, 'shift+f6'],
  ])('writes %o as %s', (chord, text) => {
    expect(writeChord(chord)).toBe(text);
  });

  /** One chord, one spelling, so two readers' settings files can be compared. */
  it('always writes the modifiers in the same order', () => {
    expect(writeChord({ ctrl: true, shift: true, alt: true, key: 'k' })).toBe('ctrl+shift+alt+k');
  });

  it('reads back everything it writes', () => {
    const chord = { ctrl: true, shift: false, alt: true, key: '7' };

    expect(parseChord(writeChord(chord))).toEqual(chord);
  });
});

describe('reading a chord back', () => {
  it.each([
    ['ctrl+b', { ctrl: true, shift: false, alt: false, key: 'b' }],
    ['CTRL+Shift+P', { ctrl: true, shift: true, alt: false, key: 'p' }],
    ['f6', { ctrl: false, shift: false, alt: false, key: 'f6' }],
    [' alt + m ', { ctrl: false, shift: false, alt: true, key: 'm' }],
  ])('reads %s', (text, chord) => {
    expect(parseChord(text)).toEqual(chord);
  });

  /**
   * Nothing rather than a guess. A hand-edited settings file should leave a key on its
   * default rather than bind something nobody meant, and the keys that are not chords at all
   * say so by failing here.
   */
  it.each(['', '   ', 'ctrl', 'ctrl+', 'esc esc', 'ctrl+wheel', 'a+b', '+'])('refuses %s', (text) => {
    expect(parseChord(text)).toBeNull();
  });
});

describe('whether a press is a chord', () => {
  const chord = parseChord('ctrl+shift+p')!;

  it('says so when it is', () => {
    expect(matchesChord(chord, press({ code: 'KeyP', ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it.each([
    ['without the shift', { code: 'KeyP', ctrlKey: true }],
    ['without the ctrl', { code: 'KeyP', shiftKey: true }],
    ['with an alt as well', { code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: true }],
    ['on another key', { code: 'KeyQ', ctrlKey: true, shiftKey: true }],
  ])('says not %s', (_what, over) => {
    expect(matchesChord(chord, press(over))).toBe(false);
  });

  /** AltGr arrives as ctrl and alt together, and must not answer a plain ctrl chord. */
  it('does not answer AltGr for a ctrl chord', () => {
    const plain = parseChord('ctrl+n')!;

    expect(matchesChord(plain, press({ code: 'KeyN', ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('says not for a press of modifiers alone', () => {
    expect(matchesChord(chord, press({ key: 'Control', ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('answers the same key whatever character it produced', () => {
    const mode = parseChord('alt+m')!;

    expect(matchesChord(mode, press({ code: 'KeyM', key: 'µ', altKey: true })), 'Option+M on a Mac').toBe(true);
  });

  it('answers either key that means plus', () => {
    const bigger = parseChord('ctrl+plus')!;

    expect(matchesChord(bigger, press({ code: 'Equal', key: '=', ctrlKey: true })), 'the unshifted key').toBe(true);
    expect(matchesChord(bigger, press({ code: 'Equal', key: '+', ctrlKey: true, shiftKey: true })), 'with shift').toBe(
      true,
    );
    expect(matchesChord(bigger, press({ code: 'NumpadAdd', ctrlKey: true })), 'the keypad').toBe(true);
  });

  /**
   * Shift is how `?` is produced rather than part of the binding, so a chord written `?`
   * has to answer a press that held shift. `shift+f6` is a different key from `f6` and
   * must not, which is the case below it.
   */
  it('ignores shift for a character shift is what produces', () => {
    const quick = parseChord('?')!;

    expect(matchesChord(quick, press({ code: 'Slash', key: '?', shiftKey: true }))).toBe(true);
  });

  it('still tells shift+f6 from f6', () => {
    const next = parseChord('f6')!;
    const previous = parseChord('shift+f6')!;

    expect(matchesChord(next, press({ code: 'F6', shiftKey: true })), 'f6 is not shift+f6').toBe(false);
    expect(matchesChord(previous, press({ code: 'F6', shiftKey: true }))).toBe(true);
  });

  it('answers either keypad or main row for a digit', () => {
    const reset = parseChord('ctrl+0')!;

    expect(matchesChord(reset, press({ code: 'Digit0', ctrlKey: true }))).toBe(true);
    expect(matchesChord(reset, press({ code: 'Numpad0', ctrlKey: true }))).toBe(true);
  });
});

describe('the chord a press makes', () => {
  it('carries the modifiers that were held', () => {
    expect(chordOf(press({ code: 'KeyK', ctrlKey: true, shiftKey: true }))).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      key: 'k',
    });
  });

  it('is nothing for modifiers on their own, so a capture waits for a real key', () => {
    expect(chordOf(press({ key: 'Shift', shiftKey: true }))).toBeNull();
  });

  /** Capturing `?` must write down `?`, since `shift+?` would then match nothing at all. */
  it('leaves shift out when shift is what produced the character', () => {
    expect(chordOf(press({ code: 'Slash', key: '?', shiftKey: true }))).toEqual({
      ctrl: false,
      shift: false,
      alt: false,
      key: '?',
    });
  });
});

describe('whether a chord has nothing to stop it being typed', () => {
  /**
   * These fire wherever the keyboard is, including inside the message box, so a chord with
   * no modifier would take a letter away from whoever is writing with it.
   */
  it.each(['b', '?', 'shift+b'])('says %s needs one', (text) => {
    expect(needsModifier(parseChord(text)!)).toBe(true);
  });

  it.each(['ctrl+b', 'alt+m', 'ctrl+shift+p', 'f6', 'shift+f6'])('says %s does not', (text) => {
    expect(needsModifier(parseChord(text)!)).toBe(false);
  });
});
