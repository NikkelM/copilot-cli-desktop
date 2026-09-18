// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { BINDINGS, useShortcuts, type Shortcut } from './useShortcuts';

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
};

let on: Mock<(shortcut: Shortcut) => void>;

beforeEach(() => {
  on = vi.fn();
  vi.useRealTimers();
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('useShortcuts', () => {
  describe('Escape', () => {
    // One Escape is how a menu closes and how a field is left. Acting on it would make
    // every dismissal stop the agent as well.
    it('does nothing on its own', () => {
      renderHook(() => useShortcuts(on));

      press('Escape');

      expect(on).not.toHaveBeenCalled();
    });

    it('acts when pressed twice', () => {
      renderHook(() => useShortcuts(on));

      press('Escape');
      press('Escape');

      expect(on).toHaveBeenCalledExactlyOnceWith('escape-twice');
    });

    it('does not act on a second press long afterwards', () => {
      vi.useFakeTimers();
      renderHook(() => useShortcuts(on));

      press('Escape');
      vi.setSystemTime(Date.now() + 5000);
      press('Escape');

      expect(on).not.toHaveBeenCalled();
    });

    // Three presses are one pair and a fresh start, not two overlapping pairs.
    it('starts again after a pair', () => {
      renderHook(() => useShortcuts(on));

      press('Escape');
      press('Escape');
      press('Escape');

      expect(on).toHaveBeenCalledTimes(1);
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

      expect(on).not.toHaveBeenCalled();
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
      const box = document.createElement('textarea');
      document.body.append(box);

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
      const box = document.createElement('textarea');
      box.value = 'the field disagrees';
      document.body.append(box);

      const event = press('?', {}, box);

      expect(on).toHaveBeenCalledExactlyOnceWith('help');
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves the mark alone when the caller says something is written', () => {
      renderHook(() => useShortcuts(on, () => 'why does'));
      const box = document.createElement('textarea');
      document.body.append(box);

      const event = press('?', {}, box);

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

    it('ignores the shifted form', () => {
      renderHook(() => useShortcuts(on));

      press('s', { ctrlKey: true, shiftKey: true });

      expect(on).not.toHaveBeenCalled();
    });
  });
});

describe('BINDINGS', () => {
  // The list a reader sees is built from these, so a shortcut this hook reports must be
  // described, and nothing described as this hook's may do nothing.
  it('describes every shortcut the hook can report', () => {
    const mine = BINDINGS.map((binding) => binding.id).filter(Boolean);
    expect(mine.sort()).toEqual([
      'escape-twice',
      'help',
      'interrupt',
      'larger',
      'reasoning',
      'reset-size',
      'smaller',
      'stash',
    ]);
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
