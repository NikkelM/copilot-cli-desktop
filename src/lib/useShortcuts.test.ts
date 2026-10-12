// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { BINDINGS, useShortcuts, type Shortcut } from './useShortcuts';
import { moduleReplaced } from './hotGeneration';

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
};

let on: Mock<(shortcut: Shortcut) => void>;

/** A field inside the message box, which is the one place a question mark is not a character. */
const inComposer = <T extends HTMLElement>(field: T): T => {
  const composer = document.createElement('div');
  composer.setAttribute('data-region', 'composer');
  composer.append(field);
  document.body.append(composer);
  return field;
};

/**
 * How many times one shortcut was reported.
 *
 * A single Escape now reports `go-composer` as well as starting the double-press window, so
 * a test about interrupting has to name what it is counting rather than count every call.
 */
const fired = (what: Shortcut) => on.mock.calls.filter(([shortcut]) => shortcut === what).length;

beforeEach(() => {
  on = vi.fn();
  vi.useRealTimers();
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('useShortcuts', () => {
  describe('Escape', () => {
    // One Escape is how a menu closes and how a field is left. Stopping the agent on it
    // would make every dismissal an interruption, so that is left to the second press.
    it('does not interrupt on its own', () => {
      renderHook(() => useShortcuts(on));

      press('Escape');

      expect(on).not.toHaveBeenCalledWith('escape-twice');
    });

    /**
     * A reader who has finished looking around wants to be back where they were writing, and
     * before this there was no key at all that moved the focus anywhere (#250).
     */
    it('goes back to the message box when pressed outside it', () => {
      renderHook(() => useShortcuts(on));

      press('Escape');

      expect(on).toHaveBeenCalledWith('go-composer');
    });

    it('does nothing on its own inside the message box', () => {
      document.body.innerHTML = '<textarea data-region="composer"></textarea>';
      const box = document.querySelector('textarea')!;
      renderHook(() => useShortcuts(on));

      press('Escape', {}, box);

      expect(on, 'already there, so the press belongs to the second').not.toHaveBeenCalled();
    });

    it('acts when pressed twice', () => {
      renderHook(() => useShortcuts(on));

      press('Escape');
      press('Escape');

      expect(fired('escape-twice')).toBe(1);
    });

    it('does not act on a second press long afterwards', () => {
      vi.useFakeTimers();
      renderHook(() => useShortcuts(on));

      press('Escape');
      vi.setSystemTime(Date.now() + 5000);
      press('Escape');

      expect(fired('escape-twice')).toBe(0);
    });

    // Three presses are one pair and a fresh start, not two overlapping pairs.
    it('starts again after a pair', () => {
      renderHook(() => useShortcuts(on));

      press('Escape');
      press('Escape');
      press('Escape');

      expect(fired('escape-twice')).toBe(1);
    });

    // A prompt or a menu that handled the press owns it; the turn behind it is not what
    // the reader meant to stop.
    it('ignores a press something else has already dealt with', () => {
      renderHook(() => useShortcuts(on));

      press('Escape');
      const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        claimed.preventDefault();
        window.dispatchEvent(claimed);
      });

      expect(fired('escape-twice')).toBe(0);
    });

    // Stopping a turn is exactly what someone typing a follow-up wants to be able to do.
    it('works while typing', () => {
      renderHook(() => useShortcuts(on));
      const box = document.createElement('textarea');
      document.body.append(box);

      press('Escape', {}, box);
      press('Escape', {}, box);

      expect(on).toHaveBeenCalledWith('escape-twice');
    });
  });

  describe('Ctrl+C', () => {
    it('stops the turn', () => {
      renderHook(() => useShortcuts(on));

      const event = press('c', { ctrlKey: true });

      expect(on).toHaveBeenCalledExactlyOnceWith('interrupt');
      expect(event.defaultPrevented).toBe(true);
    });

    // Copy comes first: taking it from someone with a selection loses them what they were
    // copying, which is worse than making them reach for Stop.
    it('leaves a copy alone', () => {
      renderHook(() => useShortcuts(on));
      const text = document.createElement('p');
      text.textContent = 'something worth copying';
      document.body.append(text);
      const range = document.createRange();
      range.selectNodeContents(text);
      window.getSelection()!.addRange(range);

      const event = press('c', { ctrlKey: true });

      expect(on).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('ignores the letter on its own', () => {
      renderHook(() => useShortcuts(on));

      press('c');

      expect(on).not.toHaveBeenCalled();
    });

    it('ignores it with other modifiers held', () => {
      renderHook(() => useShortcuts(on));

      press('c', { ctrlKey: true, shiftKey: true });

      expect(on).not.toHaveBeenCalled();
    });
  });

  describe('the shortcut list', () => {
    it('opens on a question mark', () => {
      renderHook(() => useShortcuts(on));

      press('?');

      expect(on).toHaveBeenCalledExactlyOnceWith('help');
    });

    // The composer holds the keyboard whenever a session is open, so refusing while a field
    // has focus would put the list out of reach almost all of the time.
    it('opens from an empty composer, and does not leave the mark behind', () => {
      renderHook(() => useShortcuts(on));
      const box = inComposer(document.createElement('textarea'));

      const event = press('?', {}, box);

      expect(on).toHaveBeenCalledExactlyOnceWith('help');
      expect(event.defaultPrevented).toBe(true);
    });

    // Once there is a message being written, a question mark is part of it.
    it.each(['textarea', 'input'])('stays out of the way once something is typed in a %s', (tag) => {
      renderHook(() => useShortcuts(on));
      const field = document.createElement(tag) as HTMLTextAreaElement;
      field.value = 'why does';
      document.body.append(field);

      const event = press('?', {}, field);

      expect(on).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    // The field is only where the text is shown; the app is where it is kept, and a
    // shortcut that has to ask the DOM is guessing.
    it('asks the caller what has been written rather than the field', () => {
      renderHook(() => useShortcuts(on, () => ''));
      const box = inComposer(document.createElement('textarea'));
      box.value = 'the field disagrees';

      const event = press('?', {}, box);

      expect(on).toHaveBeenCalledExactlyOnceWith('help');
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves the mark alone when the caller says something is written', () => {
      renderHook(() => useShortcuts(on, () => 'why does'));
      const box = inComposer(document.createElement('textarea'));

      const event = press('?', {}, box);

      expect(on).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    /**
     * The reasoning behind claiming the key is about a message being written. Every other
     * field in the window is somewhere a question mark is an ordinary character - answering
     * a question the agent asked with "?" is a thing people do - and the caller's getter
     * speaks for the composer alone, so an empty composer behind an elicitation was
     * answering for a box it knew nothing about and swallowing the key.
     */
    it('types the mark into a field that is not the composer', () => {
      renderHook(() => useShortcuts(on, () => ''));
      const field = document.createElement('input');
      document.body.append(field);

      const event = press('?', {}, field);

      expect(on).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });
    // A menu has no text to be the first character of, so it is left alone.
    it('stays out of the way inside a select', () => {
      renderHook(() => useShortcuts(on));
      const field = document.createElement('select');
      document.body.append(field);

      press('?', {}, field);

      expect(on).not.toHaveBeenCalled();
    });

    it('stays out of the way of anything editable', () => {
      renderHook(() => useShortcuts(on));
      const box = document.createElement('div');
      box.setAttribute('contenteditable', 'true');
      document.body.append(box);

      press('?', {}, box);

      expect(on).not.toHaveBeenCalled();
    });

    // The press lands on whatever is inside the editable region, not on the region itself.
    it('stays out of the way inside an editable region', () => {
      renderHook(() => useShortcuts(on));
      const box = document.createElement('div');
      box.setAttribute('contenteditable', 'true');
      const inner = document.createElement('span');
      box.append(inner);
      document.body.append(box);

      press('?', {}, inner);

      expect(on).not.toHaveBeenCalled();
    });
  });

  // Registered once, so a caller that rebuilds its handler each render must still be heard.
  it('calls the handler it was last given', () => {
    const { rerender } = renderHook(({ handler }) => useShortcuts(handler), { initialProps: { handler: on } });
    const later: Mock<(shortcut: Shortcut) => void> = vi.fn();

    rerender({ handler: later });
    press('c', { ctrlKey: true });

    expect(on).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledWith('interrupt');
  });

  it('stops listening once it is gone', () => {
    const { unmount } = renderHook(() => useShortcuts(on));

    unmount();
    press('c', { ctrlKey: true });

    expect(on).not.toHaveBeenCalled();
  });

  /** ctrl+b, which is what editors use for this. */
  describe('showing or hiding the sidebar', () => {
    it('reports the toggle', () => {
      renderHook(() => useShortcuts(on));

      press('b', { ctrlKey: true });

      expect(on).toHaveBeenCalledExactlyOnceWith('sidebar');
    });

    // It changes how the app is drawn rather than what is being written, so the composer
    // must not shadow it.
    it('fires while a message is being typed', () => {
      renderHook(() => useShortcuts(on));
      const field = document.createElement('textarea');
      field.value = 'half a message';
      document.body.append(field);

      press('b', { ctrlKey: true }, field);

      expect(on).toHaveBeenCalledExactlyOnceWith('sidebar');
    });

    it('leaves a plain b to be typed', () => {
      renderHook(() => useShortcuts(on));

      press('b');

      expect(on).not.toHaveBeenCalled();
    });

    it('ignores the shifted and alt forms, which are other things', () => {
      renderHook(() => useShortcuts(on));

      press('b', { ctrlKey: true, shiftKey: true });
      press('b', { ctrlKey: true, altKey: true });

      expect(on).not.toHaveBeenCalled();
    });

    it('is offered in the quick help, so it is not only findable by guessing', () => {
      expect(BINDINGS.some((binding) => binding.id === 'sidebar' && binding.keys === 'ctrl+b')).toBe(true);
    });
  });

  /** ctrl+t, which the CLI answers wherever the cursor happens to be. */
  describe('showing or hiding reasoning', () => {
    it('reports the toggle', () => {
      renderHook(() => useShortcuts(on));

      press('t', { ctrlKey: true });

      expect(on).toHaveBeenCalledExactlyOnceWith('reasoning');
    });

    // It changes what is on screen rather than what is being written, so the composer
    // holding the keyboard - which it does whenever a session is open - must not shadow it.
    it('fires while a message is being typed', () => {
      renderHook(() => useShortcuts(on));
      const field = document.createElement('textarea');
      field.value = 'half a message';
      document.body.append(field);

      press('t', { ctrlKey: true }, field);

      expect(on).toHaveBeenCalledExactlyOnceWith('reasoning');
    });

    it('leaves a plain t to be typed', () => {
      renderHook(() => useShortcuts(on));

      press('t');

      expect(on).not.toHaveBeenCalled();
    });

    // ctrl+shift+t reopens a closed tab in a browser, and is not this.
    it('ignores the shifted form', () => {
      renderHook(() => useShortcuts(on));

      press('t', { ctrlKey: true, shiftKey: true });

      expect(on).not.toHaveBeenCalled();
    });
  });

  describe('stashing the prompt', () => {
    // Only useful while typing, which is where it has to work.
    it('fires while a message is being typed', () => {
      renderHook(() => useShortcuts(on));
      const field = document.createElement('textarea');
      field.value = 'half a message';
      document.body.append(field);

      press('s', { ctrlKey: true }, field);

      expect(on).toHaveBeenCalledExactlyOnceWith('stash');
    });

    // The webview would otherwise offer to save the page, which this app has no notion of.
    it('takes the key off the webview', () => {
      renderHook(() => useShortcuts(on));

      expect(press('s', { ctrlKey: true }).defaultPrevented).toBe(true);
    });

    it('leaves a plain s to be typed', () => {
      renderHook(() => useShortcuts(on));

      press('s');

      expect(on).not.toHaveBeenCalled();
    });

    // Stashing is ctrl+s alone. The shifted form is the key for the session list, which is
    // a different thing entirely, so this says only that it is not mistaken for a stash.
    it('ignores the shifted form', () => {
      renderHook(() => useShortcuts(on));

      press('s', { ctrlKey: true, shiftKey: true });

      expect(fired('stash')).toBe(0);
    });
  });
});

/**
 * Getting from one part of the window to another (#250).
 *
 * All of these are claimed whatever has the keyboard, because the whole point of them is to
 * work from inside the box that currently holds it. Shift is reported as an upper case
 * letter by every browser, which is what these press.
 */
describe('moving about the window', () => {
  const cases: [string, string, KeyboardEventInit, Shortcut][] = [
    ['ctrl+n', 'n', { ctrlKey: true }, 'new-session'],
    ['ctrl+shift+p', 'P', { ctrlKey: true, shiftKey: true }, 'find-session'],
    ['ctrl+shift+s', 'S', { ctrlKey: true, shiftKey: true }, 'go-sessions'],
    ['ctrl+shift+m', 'M', { ctrlKey: true, shiftKey: true }, 'go-composer'],
    ['ctrl+shift+k', 'K', { ctrlKey: true, shiftKey: true }, 'wiki'],
    ['ctrl+shift+o', 'O', { ctrlKey: true, shiftKey: true }, 'import'],
    ['f6', 'F6', {}, 'next-region'],
    ['shift+f6', 'F6', { shiftKey: true }, 'previous-region'],
  ];

  it.each(cases)('reports %s', (_name, key, init, shortcut) => {
    renderHook(() => useShortcuts(on));

    press(key, init);

    expect(on).toHaveBeenCalledWith(shortcut);
  });

  /**
   * Ctrl+N is the webview's own "new window" and F6 is its address bar, so leaving the press
   * alone would do this app's thing and the browser's at once.
   */
  it.each(cases)('claims %s rather than leaving it to the webview', (_name, key, init) => {
    renderHook(() => useShortcuts(on));

    const event = press(key, init);

    expect(event.defaultPrevented).toBe(true);
  });

  it.each(cases)('answers %s while a message is being written', (_name, key, init, shortcut) => {
    document.body.innerHTML = '<textarea data-region="composer">half a thought</textarea>';
    const box = document.querySelector('textarea')!;
    renderHook(() => useShortcuts(on));

    press(key, init, box);

    expect(on).toHaveBeenCalledWith(shortcut);
  });

  // Ctrl+Shift+N opens a private window in a browser, and is not this.
  it('does not start a session on the shifted form', () => {
    renderHook(() => useShortcuts(on));

    press('N', { ctrlKey: true, shiftKey: true });

    expect(fired('new-session')).toBe(0);
  });

  /**
   * The composer keeps ctrl+k and ctrl+u for readline's own line editing, and those are the
   * unshifted keys. Shift makes the letter upper case, so the two cannot be mistaken for one
   * another - but only for as long as nothing here answers the unshifted one as well.
   *
   * Ctrl+O is the pair that is no longer free: it folds the transcript (#135), so the test
   * is that the shifted key still means importing and not that the unshifted one is idle.
   */
  it.each<[string, string, Shortcut]>([
    ['ctrl+k', 'k', 'wiki'],
    ['ctrl+o', 'o', 'import'],
  ])('leaves %s to whatever already has it', (_name, key, shortcut) => {
    renderHook(() => useShortcuts(on));

    press(key, { ctrlKey: true });

    expect(fired(shortcut)).toBe(0);
  });

  it('folds the transcript on the unshifted ctrl+o', () => {
    renderHook(() => useShortcuts(on));

    press('o', { ctrlKey: true });

    expect(fired('fold-all')).toBe(1);
  });
});

/**
 * A key a reader moved (#246).
 *
 * The point of matching against a table rather than a chain of conditions: the hook answers
 * whatever the bindings say, so a changed key works and the one it replaced stops.
 */
describe('keys a reader changed', () => {
  it('answers the key they chose', () => {
    renderHook(() => useShortcuts(on, undefined, { sidebar: 'ctrl+shift+b' }));

    press('B', { ctrlKey: true, shiftKey: true });

    expect(fired('sidebar')).toBe(1);
  });

  it('stops answering the one it replaced', () => {
    renderHook(() => useShortcuts(on, undefined, { sidebar: 'ctrl+shift+b' }));

    press('b', { ctrlKey: true });

    expect(fired('sidebar')).toBe(0);
  });

  /** Cleared on purpose means nothing answers it, which is not the same as left alone. */
  it('answers nothing for a key that was cleared', () => {
    renderHook(() => useShortcuts(on, undefined, { sidebar: '' }));

    press('b', { ctrlKey: true });

    expect(fired('sidebar')).toBe(0);
  });

  it('leaves the keys they did not change where they were', () => {
    renderHook(() => useShortcuts(on, undefined, { sidebar: 'ctrl+shift+b' }));

    press('t', { ctrlKey: true });

    expect(fired('reasoning')).toBe(1);
  });

  /**
   * The listener is registered once and reads the bindings through a ref, so a change made
   * while the app is open has to reach it without the effect running again.
   */
  it('takes effect without waiting for a restart', () => {
    const { rerender } = renderHook(({ overrides }) => useShortcuts(on, undefined, overrides), {
      initialProps: { overrides: {} as Record<string, string> },
    });

    rerender({ overrides: { sidebar: 'ctrl+shift+b' } });
    press('B', { ctrlKey: true, shiftKey: true });

    expect(fired('sidebar')).toBe(1);
  });

  /** Still swallowed, since the webview would otherwise do its own thing with the press. */
  it('takes the press it answers', () => {
    renderHook(() => useShortcuts(on, undefined, { sidebar: 'ctrl+shift+b' }));

    expect(press('B', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  });

  /** A moved key keeps whatever else it asks. Copy still comes first for interrupting. */
  it('keeps the rule that goes with the key rather than the chord', () => {
    const selected = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'picked' } as Selection);
    renderHook(() => useShortcuts(on, undefined, { interrupt: 'ctrl+shift+c' }));

    press('C', { ctrlKey: true, shiftKey: true });

    expect(fired('interrupt')).toBe(0);
    selected.mockRestore();
  });
});

describe('BINDINGS', () => {  // The list a reader sees is built from these, so a shortcut this hook reports must be
  // described, and nothing described as the app's may do nothing.
  it('describes every shortcut the app can report', () => {
    const mine = BINDINGS.map((binding) => binding.id).filter(Boolean);
    expect(mine.sort()).toEqual([
      'attach',
      'cycle-mode',
      'escape-twice',
      'find-here',
      'find-session',
      'fold-all',
      'go-composer',
      'go-sessions',
      'help',
      'import',
      'interrupt',
      'larger',
      'new-session',
      'next-region',
      'previous-region',
      'reasoning',
      'reset-size',
      'sidebar',
      'smaller',
      'stash',
      'wiki',
    ]);
  });

  /**
   * The composer answers these two itself, since both are about what is being written. They
   * carry an id even so, because that is what makes a key changeable (#246) and a reader
   * cannot tell which part of the app answers a key.
   */
  it.each<Shortcut>(['cycle-mode', 'attach'])('leaves %s to the composer', (id) => {
    renderHook(() => useShortcuts(on));

    press(id === 'attach' ? 'A' : 'm', id === 'attach' ? { ctrlKey: true, shiftKey: true } : { altKey: true });

    expect(fired(id)).toBe(0);
  });

  // The rest are the composer's and the menu's. They are listed because the reader does not
  // care which part of the app answers a key, only that pressing it does something.
  it('covers keys this hook does not own', () => {
    const others = BINDINGS.filter((binding) => !binding.id).map((binding) => binding.keys);
    expect(others).toContain('/');
    expect(others).toContain('shift+enter');
  });

  /**
   * A reference that spends its rows on arrows and Tab buries the keys nothing else would
   * reveal, and a list on screen already invites them.
   */
  it('leaves out plain navigation', () => {
    const keys = BINDINGS.map((binding) => binding.keys);
    expect(keys).not.toContain('Tab');
    expect(keys).not.toContain('↑ ↓');
    expect(keys).not.toContain('esc');
  });

  // Worded as the CLI words its own, so the two read as one tool.
  it('is worded in lower case, as the CLI is', () => {
    for (const binding of BINDINGS) {
      expect(binding.what).toBe(binding.what.toLowerCase());
      expect(binding.keys).toBe(binding.keys.toLowerCase());
    }
  });

  it('says which keys to press and what they do', () => {
    for (const binding of BINDINGS) {
      expect(binding.keys.length).toBeGreaterThan(0);
      expect(binding.what.length).toBeGreaterThan(0);
    }
  });

  // Two rows reading the same would be two rows the reader has to tell apart.
  it('names each key once', () => {
    const keys = BINDINGS.map((binding) => binding.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('drawing everything larger or smaller', () => {
  const typing = () => {
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    return box;
  };

  it('goes up on ctrl and plus', () => {
    renderHook(() => useShortcuts(on));

    press('+', { ctrlKey: true });

    expect(on).toHaveBeenCalledExactlyOnceWith('larger');
  });

  /** The unshifted key every browser and editor accepts for this. */
  it('takes ctrl and equals as the same thing', () => {
    renderHook(() => useShortcuts(on));

    press('=', { ctrlKey: true });

    expect(on).toHaveBeenCalledExactlyOnceWith('larger');
  });

  it('goes down on ctrl and minus', () => {
    renderHook(() => useShortcuts(on));

    press('-', { ctrlKey: true });

    expect(on).toHaveBeenCalledExactlyOnceWith('smaller');
  });

  it('answers the numeric keypad too', () => {
    renderHook(() => useShortcuts(on));

    press('Unidentified', { ctrlKey: true, code: 'NumpadAdd' });
    press('Unidentified', { ctrlKey: true, code: 'NumpadSubtract' });

    expect(on).toHaveBeenNthCalledWith(1, 'larger');
    expect(on).toHaveBeenNthCalledWith(2, 'smaller');
  });

  it('goes back to the default on ctrl and zero', () => {
    renderHook(() => useShortcuts(on));

    press('0', { ctrlKey: true });

    expect(on).toHaveBeenCalledExactlyOnceWith('reset-size');
  });

  /**
   * The webview zooms on these itself, which would scale the app a second time on top of
   * this one and could not be put back by ctrl+0 alone.
   */
  it('keeps the webview from zooming as well', () => {
    renderHook(() => useShortcuts(on));

    for (const key of ['+', '=', '-', '0']) {
      expect(press(key, { ctrlKey: true }).defaultPrevented).toBe(true);
    }
  });

  // It changes how the app is drawn rather than what is being written, like ctrl+t.
  it('fires while a message is being typed', () => {
    renderHook(() => useShortcuts(on));

    press('+', { ctrlKey: true }, typing());

    expect(on).toHaveBeenCalledExactlyOnceWith('larger');
  });

  it('leaves plus alone without ctrl, which is a character', () => {
    renderHook(() => useShortcuts(on));

    press('+');

    expect(on).not.toHaveBeenCalled();
  });

  it('leaves ctrl and alt together alone, which is a keyboard layout', () => {
    renderHook(() => useShortcuts(on));

    press('+', { ctrlKey: true, altKey: true });

    expect(on).not.toHaveBeenCalled();
  });

  it('does not answer another ctrl key with a size change', () => {
    renderHook(() => useShortcuts(on));

    press('p', { ctrlKey: true });

    expect(on).not.toHaveBeenCalledWith('larger');
    expect(on).not.toHaveBeenCalledWith('smaller');
    expect(on).not.toHaveBeenCalledWith('reset-size');
  });

  it('is listed in the help', () => {
    const listed = BINDINGS.filter((b) => b.id === 'larger' || b.id === 'smaller' || b.id === 'reset-size');

    expect(listed).toHaveLength(3);
  });
});

describe('ctrl and the wheel', () => {
  const wheel = (deltaY: number, init: WheelEventInit = {}) => {
    const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init });
    act(() => void window.dispatchEvent(event));
    return event;
  };

  it('goes up on a wheel turned away', () => {
    renderHook(() => useShortcuts(on));

    wheel(-120, { ctrlKey: true });

    expect(on).toHaveBeenCalledExactlyOnceWith('larger');
  });

  it('goes down on a wheel turned towards', () => {
    renderHook(() => useShortcuts(on));

    wheel(120, { ctrlKey: true });

    expect(on).toHaveBeenCalledExactlyOnceWith('smaller');
  });

  // Scrolling the transcript is what the wheel is for the rest of the time.
  it('leaves an ordinary scroll alone', () => {
    renderHook(() => useShortcuts(on));

    wheel(-120);

    expect(on).not.toHaveBeenCalled();
  });

  it('keeps the webview from zooming as well', () => {
    renderHook(() => useShortcuts(on));

    expect(wheel(-120, { ctrlKey: true }).defaultPrevented).toBe(true);
  });

  it('does not act on a wheel event that moved nothing', () => {
    renderHook(() => useShortcuts(on));

    wheel(0, { ctrlKey: true });

    expect(on).not.toHaveBeenCalled();
  });

  it('stops listening once the app is gone', () => {
    const { unmount } = renderHook(() => useShortcuts(on));

    unmount();
    wheel(-120, { ctrlKey: true });

    expect(on).not.toHaveBeenCalled();
  });
});

/**
 * The listener has to be the one that was just edited, or a change to a key looks like a
 * key that does nothing - which is exactly how the wheel binding appeared when it was
 * first added (#181).
 */
describe('surviving a hot update', () => {
  /**
   * The listener function itself is what goes stale - the handler is already read through a
   * ref, so a test that only replaces the handler passes either way and proves nothing. What
   * the counter buys is the subscription being torn down and made again, with whatever the
   * edited module now defines.
   */
  it('registers its listeners again', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    renderHook(() => useShortcuts(on));
    added.mockClear();
    removed.mockClear();

    act(() => moduleReplaced());

    expect(removed.mock.calls.map(([type]) => type)).toEqual(['keydown', 'wheel']);
    expect(added.mock.calls.map(([type]) => type)).toEqual(['keydown', 'wheel']);
    added.mockRestore();
    removed.mockRestore();
  });

  it('does not register again without one', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const { rerender } = renderHook(() => useShortcuts(on));
    added.mockClear();

    rerender();

    expect(added).not.toHaveBeenCalled();
    added.mockRestore();
  });

  it('does not answer twice after re-registering', () => {
    renderHook(() => useShortcuts(on));

    act(() => moduleReplaced());
    press('+', { ctrlKey: true });

    expect(on).toHaveBeenCalledTimes(1);
  });

  it('still answers the wheel after one', () => {
    renderHook(() => useShortcuts(on));

    act(() => moduleReplaced());
    act(() => void window.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, cancelable: true })));

    expect(on).toHaveBeenCalledExactlyOnceWith('larger');
  });
});

