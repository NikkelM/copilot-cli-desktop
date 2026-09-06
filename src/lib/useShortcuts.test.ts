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

    // The composer holds the keyboard whenever a session is open, so the bare key alone
    // would be unreachable almost all of the time.
    it('opens on F1 even while typing', () => {
      renderHook(() => useShortcuts(on));
      const box = document.createElement('textarea');
      document.body.append(box);

      const event = press('F1', {}, box);

      expect(on).toHaveBeenCalledExactlyOnceWith('help');
      expect(event.defaultPrevented).toBe(true);
    });

    // Where a question mark is just a question mark.
    it.each(['textarea', 'input', 'select'])('stays out of the way inside a %s', (tag) => {
      renderHook(() => useShortcuts(on));
      const field = document.createElement(tag);
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
});

describe('BINDINGS', () => {
  // The list a reader sees is built from these, so a shortcut that does something must be
  // described, and nothing described may do nothing.
  it('describes every shortcut the hook can report', () => {
    expect(BINDINGS.map((binding) => binding.id).sort()).toEqual(['escape-twice', 'help', 'interrupt']);
  });

  it('says which keys to press and what they do', () => {
    for (const binding of BINDINGS) {
      expect(binding.keys.length).toBeGreaterThan(0);
      expect(binding.what.length).toBeGreaterThan(0);
    }
  });
});
