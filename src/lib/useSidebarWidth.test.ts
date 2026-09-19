// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useSidebarWidth } from './useSidebarWidth';
import { DEFAULT_MULTIPLE, HIDDEN_KEY, NARROWEST, WIDEST, WIDTH_KEY } from './sidebarWidth';
import { read, resetStores } from './store';

const column = () => document.documentElement.style.getPropertyValue('--sidebar-column');

/** Drive a drag the way a pointer does: press, move to an absolute x, release. */
function drag(start: () => void, xs: number[]) {
  act(() => start());
  for (const clientX of xs) {
    act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX })));
  }
  act(() => void window.dispatchEvent(new MouseEvent('pointerup')));
}

beforeEach(() => {
  localStorage.clear();
  resetStores();
  document.documentElement.style.removeProperty('--sidebar-column');
  // jsdom reports 16px for the root font size, which is the app's own default base.
  document.documentElement.style.fontSize = '16px';
  document.documentElement.classList.remove('sidebar-hidden');
});

describe('the sidebar width', () => {
  it('leaves the column to the stylesheet until someone chooses', () => {
    const { result } = renderHook(() => useSidebarWidth());

    expect(result.current.multiple).toBeNull();
    expect(column()).toBe('');
  });

  it('follows the pointer, in multiples of the text size', () => {
    const { result } = renderHook(() => useSidebarWidth());

    drag(result.current.start, [400]);

    expect(result.current.multiple).toBe(25); // 400px at a 16px base
    expect(column()).toBe('calc(var(--font-base) * 25)');
  });

  it('takes where the pointer is, not how far it has moved', () => {
    // A pointer that leaves the window and comes back would otherwise have moved the edge
    // by however far it travelled outside it.
    const { result } = renderHook(() => useSidebarWidth());

    drag(result.current.start, [400, 320, 400]);

    expect(result.current.multiple).toBe(25);
  });

  it('stops following once the pointer is released', () => {
    const { result } = renderHook(() => useSidebarWidth());
    drag(result.current.start, [400]);

    act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600 })));

    expect(result.current.multiple).toBe(25);
  });

  it('gives up the drag when something else interrupts it', () => {
    const { result } = renderHook(() => useSidebarWidth());
    act(() => result.current.start());
    act(() => void window.dispatchEvent(new MouseEvent('pointercancel')));

    act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600 })));

    expect(result.current.multiple).toBeNull();
  });

  it('will not be dragged past either end', () => {
    const { result } = renderHook(() => useSidebarWidth());

    drag(result.current.start, [2]);
    expect(result.current.multiple).toBe(NARROWEST);

    drag(result.current.start, [4000]);
    expect(result.current.multiple).toBe(WIDEST);
  });

  it('says while it is being dragged, so the window can say so too', () => {
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.dragging).toBe(false);

    act(() => result.current.start());
    expect(result.current.dragging).toBe(true);

    act(() => void window.dispatchEvent(new MouseEvent('pointerup')));
    expect(result.current.dragging).toBe(false);
  });

  it('remembers a width, and is still at it next time', () => {
    const first = renderHook(() => useSidebarWidth());
    drag(first.result.current.start, [400]);
    expect(read('settings', WIDTH_KEY)).toBe('25');

    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.multiple).toBe(25);
    expect(column()).toBe('calc(var(--font-base) * 25)');
  });

  it('forgets a width rather than storing the default, so the default can move', () => {
    const { result } = renderHook(() => useSidebarWidth());
    drag(result.current.start, [400]);

    act(() => result.current.reset());

    expect(result.current.multiple).toBeNull();
    expect(read('settings', WIDTH_KEY)).toBeNull();
    expect(column()).toBe('');
  });

  describe('moving the edge by a step', () => {
    it('moves it from where it is, not from the default', () => {
      const { result } = renderHook(() => useSidebarWidth());
      drag(result.current.start, [400]);

      act(() => result.current.nudge(1));

      expect(result.current.multiple).toBe(26);
    });

    it('starts from the sidebar as drawn when none was ever chosen', () => {
      // The stored width is null until someone chooses, so the first press has to measure
      // what is on screen rather than jump somewhere else.
      const sidebar = document.createElement('div');
      sidebar.className = 'sidebar';
      sidebar.getBoundingClientRect = () => ({ width: 320 }) as DOMRect;
      document.body.append(sidebar);
      const { result } = renderHook(() => useSidebarWidth());

      act(() => result.current.nudge(-1));

      expect(result.current.multiple).toBe(19); // 320px / 16px, one step narrower
      sidebar.remove();
    });

    it('falls back to the default when there is no sidebar to measure', () => {
      const { result } = renderHook(() => useSidebarWidth());

      act(() => result.current.nudge(0));

      expect(result.current.multiple).toBe(DEFAULT_MULTIPLE);
    });

    it('will not step past either end', () => {
      const { result } = renderHook(() => useSidebarWidth());
      drag(result.current.start, [NARROWEST * 16]);

      act(() => result.current.nudge(-5));

      expect(result.current.multiple).toBe(NARROWEST);
    });
  });
});

describe('hiding the sidebar', () => {
  const hiddenNow = () => document.documentElement.classList.contains('sidebar-hidden');

  it('is shown to begin with', () => {
    const { result } = renderHook(() => useSidebarWidth());

    expect(result.current.hidden).toBe(false);
    expect(hiddenNow()).toBe(false);
  });

  it('hides and shows again on the same key', () => {
    const { result } = renderHook(() => useSidebarWidth());

    act(() => result.current.toggle());
    expect(result.current.hidden).toBe(true);
    expect(hiddenNow()).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.hidden).toBe(false);
    expect(hiddenNow()).toBe(false);
  });

  it('is still hidden next time', () => {
    const first = renderHook(() => useSidebarWidth());
    act(() => first.result.current.toggle());
    expect(read('settings', HIDDEN_KEY)).toBe('true');

    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.hidden).toBe(true);
    expect(hiddenNow()).toBe(true);
  });

  it('comes back when its edge is taken hold of', () => {
    // The visible way back, which a shortcut on its own would not be.
    const { result } = renderHook(() => useSidebarWidth());
    act(() => result.current.toggle());

    act(() => result.current.start());

    expect(result.current.hidden).toBe(false);
  });

  it('comes back when the edge is moved by a key', () => {
    const { result } = renderHook(() => useSidebarWidth());
    act(() => result.current.toggle());

    act(() => result.current.nudge(1));

    expect(result.current.hidden).toBe(false);
  });

  it('keeps the width someone chose, so showing it again brings back theirs', () => {
    const { result } = renderHook(() => useSidebarWidth());
    drag(result.current.start, [400]);

    act(() => result.current.toggle());
    act(() => result.current.toggle());

    expect(result.current.multiple).toBe(25);
  });

  it('can be shown without being toggled, for a caller that only wants it back', () => {
    const { result } = renderHook(() => useSidebarWidth());
    act(() => result.current.toggle());

    act(() => result.current.show());
    act(() => result.current.show());

    expect(result.current.hidden).toBe(false);
  });
});