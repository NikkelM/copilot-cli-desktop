// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTES_MULTIPLE,
  NARROWEST_NOTES,
  NOTES_WIDTH_KEY,
  SESSION_SHARE,
  WIDEST_NOTES,
  clampNotesWidth,
  readNotesWidth,
  roomForNotes,
} from './notesWidth';
import { useNotesWidth } from './useNotesWidth';
import { read, save } from './store';

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--notes-column');
  // jsdom reports a zero-width window unless told otherwise, and a drag reads this.
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
});

const drag = (clientX: number) =>
  act(() => void window.dispatchEvent(new PointerEvent('pointermove', { clientX })));
const release = () => act(() => void window.dispatchEvent(new PointerEvent('pointerup')));
const column = () => document.documentElement.style.getPropertyValue('--notes-column');

describe('keeping a width inside what is usable', () => {
  it('leaves an ordinary one alone', () => {
    expect(clampNotesWidth(30)).toBe(30);
  });

  it('refuses one too narrow to read a line of prose in', () => {
    expect(clampNotesWidth(2)).toBe(NARROWEST_NOTES);
  });

  it('refuses one wider than anything could sensibly be', () => {
    expect(clampNotesWidth(500)).toBe(WIDEST_NOTES);
  });

  it('rounds off the pixel noise a drag accumulates', () => {
    expect(clampNotesWidth(25.126_59)).toBe(25.13);
  });

  it('falls back to the default for something that is not a number', () => {
    expect(clampNotesWidth(Number.NaN)).toBe(DEFAULT_NOTES_MULTIPLE);
  });

  it('refuses one wider than the room it was told there is', () => {
    expect(clampNotesWidth(60, 40)).toBe(40);
  });

  it('leaves one that fits in that room alone', () => {
    expect(clampNotesWidth(30, 40)).toBe(30);
  });

  /** A column too narrow to read is worse than one leaving the session slightly less. */
  it('keeps it readable even when there is no room for that', () => {
    expect(clampNotesWidth(30, 2)).toBe(NARROWEST_NOTES);
  });

  it('still refuses an absurd width however much room it is told there is', () => {
    expect(clampNotesWidth(500, 900)).toBe(WIDEST_NOTES);
  });
});

/**
 * What the column may take: the window, less the fifth the session keeps, less whatever the
 * sidebar is already using. The stylesheet says the same thing in its own terms.
 */
describe('how much room there is for the notes', () => {
  it('is the window less the session share, where there is no sidebar drawn', () => {
    expect(roomForNotes(16)).toBe((1600 * 0.8) / 16);
  });

  it('is measured in multiples of the text size, so it moves with it', () => {
    expect(roomForNotes(32)).toBe((1600 * 0.8) / 32);
  });

  it('leaves out what the sidebar is taking', () => {
    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';
    sidebar.getBoundingClientRect = () => ({ width: 320 }) as DOMRect;
    document.body.append(sidebar);

    expect(roomForNotes(16)).toBe((1600 * 0.8 - 320) / 16);
  });

  it('leaves the session its share whatever the two columns do', () => {
    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';
    sidebar.getBoundingClientRect = () => ({ width: 600 }) as DOMRect;
    document.body.append(sidebar);

    expect(roomForNotes(16) * 16 + 600).toBeLessThanOrEqual(1600 * (1 - SESSION_SHARE));
  });
});

describe('what was chosen last time', () => {
  it('is nothing at all before anybody has chosen', () => {
    expect(readNotesWidth()).toBeNull();
  });

  it('is what was stored', () => {
    save('settings', NOTES_WIDTH_KEY, '30');

    expect(readNotesWidth()).toBe(30);
  });

  it('is brought inside the range on the way in, not only on the way out', () => {
    save('settings', NOTES_WIDTH_KEY, '900');

    expect(readNotesWidth()).toBe(WIDEST_NOTES);
  });

  it('is nothing for a stored value that is not a number', () => {
    save('settings', NOTES_WIDTH_KEY, 'wide');

    expect(readNotesWidth()).toBeNull();
  });
});

describe('dragging the edge', () => {
  it('leaves the column to the stylesheet until somebody drags it', () => {
    renderHook(() => useNotesWidth());

    expect(column()).toBe('');
  });

  /**
   * The width is whatever is left between the pointer and the window's right edge, which is
   * where this column ends. The sidebar's is measured from the left for the same reason.
   */
  it('measures from the right edge, where this column ends', () => {
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.start());
    drag(1600 - 480);
    release();

    expect(result.current.multiple).toBe(30);
  });

  it('follows the pointer while it moves', () => {
    const { result } = renderHook(() => useNotesWidth());
    act(() => result.current.start());

    drag(1600 - 480);
    drag(1600 - 320);
    release();

    expect(result.current.multiple).toBe(20);
  });

  it('puts what was dragged into effect', () => {
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.start());
    drag(1600 - 480);

    expect(column()).toBe('calc(var(--font-base) * 30)');
  });

  it('remembers it for next time', () => {
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.start());
    drag(1600 - 480);
    release();

    expect(read('settings', NOTES_WIDTH_KEY)).toBe('30');
  });

  it('stops following once the pointer is let go', () => {
    const { result } = renderHook(() => useNotesWidth());
    act(() => result.current.start());
    drag(1600 - 480);

    release();
    drag(1600 - 160);

    expect(result.current.multiple).toBe(30);
  });

  /** A drag interrupted by anything else ends rather than following the pointer invisibly. */
  it('stops following when the drag is taken away', () => {
    const { result } = renderHook(() => useNotesWidth());
    act(() => result.current.start());
    act(() => void window.dispatchEvent(new PointerEvent('pointercancel')));

    drag(1600 - 160);

    expect(column()).toBe('');
  });

  it('says while it is dragging, so the app can hold the caret still', () => {
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.start());

    expect(result.current.dragging).toBe(true);
  });

  it('refuses to be dragged narrower than prose can be read at', () => {
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.start());
    drag(1600 - 16);
    release();

    expect(result.current.multiple).toBe(NARROWEST_NOTES);
  });
});

/**
 * A drag is one pointer event a frame, and a render of this app is a render of the
 * transcript, the sidebar and whatever page the notes column is holding. The width is a
 * custom property, so the document can be told directly and React told once, at the end.
 */
describe('not re-rendering the app on every frame of a drag', () => {
  it('moves the edge without telling React anything', () => {
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.start());
    drag(1600 - 480);

    expect(column()).toBe('calc(var(--font-base) * 30)');
    expect(result.current.multiple).toBeNull();
  });

  it('does not draw the app again for each move', () => {
    let draws = 0;
    const { result } = renderHook(() => {
      draws += 1;
      return useNotesWidth();
    });
    act(() => result.current.start());
    const before = draws;

    drag(1600 - 480);
    drag(1600 - 420);
    drag(1600 - 360);

    expect(draws).toBe(before);
  });

  it('tells React once, when the pointer is let go', () => {
    const { result } = renderHook(() => useNotesWidth());
    act(() => result.current.start());
    drag(1600 - 480);
    drag(1600 - 320);

    release();

    expect(result.current.multiple).toBe(20);
  });

  /** Nothing was dragged, so there is nothing to write down and nothing to tell React. */
  it('writes nothing down for a press that never moved', () => {
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.start());
    release();

    expect(result.current.multiple).toBeNull();
    expect(read('settings', NOTES_WIDTH_KEY)).toBeNull();
  });

  it('keeps what was dragged when the drag is taken away rather than released', () => {
    const { result } = renderHook(() => useNotesWidth());
    act(() => result.current.start());
    drag(1600 - 480);

    act(() => void window.dispatchEvent(new PointerEvent('pointercancel')));

    expect(result.current.multiple).toBe(30);
  });
});

describe('giving the width back', () => {
  it('hands the column back to the stylesheet', () => {
    const { result } = renderHook(() => useNotesWidth());
    act(() => result.current.start());
    drag(1600 - 480);
    release();

    act(() => result.current.reset());

    expect(column()).toBe('');
  });

  /**
   * A drag writes the property straight to the document, so the state can still be null
   * with a width in force. Setting null again would change nothing and leave it there.
   */
  it('hands it back even when React was never told the dragged width', () => {
    const { result } = renderHook(() => useNotesWidth());
    act(() => result.current.start());
    drag(1600 - 480);

    act(() => result.current.reset());

    expect(column()).toBe('');
  });

  it('forgets what was chosen, rather than storing the default as a choice', () => {
    const { result } = renderHook(() => useNotesWidth());
    act(() => result.current.start());
    drag(1600 - 480);
    release();

    act(() => result.current.reset());

    expect(read('settings', NOTES_WIDTH_KEY)).toBeNull();
  });
});

describe('moving the edge by keyboard', () => {
  it('widens from where the column already is', () => {
    save('settings', NOTES_WIDTH_KEY, '30');
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.nudge(1));

    expect(result.current.multiple).toBe(31);
  });

  it('narrows the other way', () => {
    save('settings', NOTES_WIDTH_KEY, '30');
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.nudge(-1));

    expect(result.current.multiple).toBe(29);
  });

  /**
   * Both ends apply: the fixed range, and the room the window has after the session and
   * the sidebar have taken theirs. In this window the room is the binding one.
   */
  it('stays inside the room the window has', () => {
    save('settings', NOTES_WIDTH_KEY, String(WIDEST_NOTES));
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.nudge(1));

    expect(result.current.multiple).toBe(roomForNotes(16));
  });

  /** Null until somebody has chosen, so the first press must move from the width in force. */
  it('moves from the width in force rather than jumping to a default', () => {
    const { result } = renderHook(() => useNotesWidth());

    act(() => result.current.nudge(1));

    expect(result.current.multiple).toBe(DEFAULT_NOTES_MULTIPLE + 1);
  });
});
