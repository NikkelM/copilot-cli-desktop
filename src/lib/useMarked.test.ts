// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useMarked } from './useMarked';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

const plain = { toggle: false, range: false };
const ctrl = { toggle: true, range: false };
const shift = { toggle: false, range: true };

const marking = (order: readonly string[] = ORDER) =>
  renderHook(({ rows }) => useMarked(rows), { initialProps: { rows: order } });

/**
 * The sessions picked out to be acted on together (#63).
 *
 * Ctrl and Shift, because that is what every list on the machine does.
 */
describe('marking several sessions', () => {
  it('starts with nothing marked', () => {
    expect(marking().result.current.marked).toEqual([]);
  });

  it('marks one that is ctrl-clicked', () => {
    const { result } = marking();

    act(() => void result.current.click('b', ctrl, ORDER));

    expect(result.current.marked).toEqual(['b']);
  });

  it('gathers several, one ctrl-click at a time', () => {
    const { result } = marking();

    act(() => void result.current.click('b', ctrl, ORDER));
    act(() => void result.current.click('d', ctrl, ORDER));

    expect(result.current.marked).toEqual(['b', 'd']);
  });

  it('takes one back off when it is ctrl-clicked again', () => {
    const { result } = marking();
    act(() => void result.current.click('b', ctrl, ORDER));

    act(() => void result.current.click('b', ctrl, ORDER));

    expect(result.current.marked).toEqual([]);
  });

  /** A plain click is about going somewhere, and arriving ends what was being gathered. */
  it('clears everything on an ordinary click', () => {
    const { result } = marking();
    act(() => void result.current.click('b', ctrl, ORDER));

    act(() => void result.current.click('d', plain, ORDER));

    expect(result.current.marked).toEqual([]);
  });

  it('says an ordinary click was not handled as marking', () => {
    const { result } = marking();
    let handled = true;

    act(() => {
      handled = result.current.click('b', plain, ORDER);
    });

    expect(handled).toBe(false);
  });

  it('says a ctrl-click was', () => {
    const { result } = marking();
    let handled = false;

    act(() => {
      handled = result.current.click('b', ctrl, ORDER);
    });

    expect(handled).toBe(true);
  });

  describe('a range', () => {
    it('marks everything between the last row touched and this one', () => {
      const { result } = marking();
      act(() => void result.current.click('b', plain, ORDER));

      act(() => void result.current.click('d', shift, ORDER));

      expect(result.current.marked).toEqual(['b', 'c', 'd']);
    });

    it('reaches backwards as readily as forwards', () => {
      const { result } = marking();
      act(() => void result.current.click('d', plain, ORDER));

      act(() => void result.current.click('b', shift, ORDER));

      expect(result.current.marked).toEqual(['b', 'c', 'd']);
    });

    it('adds to what was already marked rather than replacing it', () => {
      const { result } = marking();
      act(() => void result.current.click('a', ctrl, ORDER));
      act(() => void result.current.click('c', ctrl, ORDER));

      act(() => void result.current.click('e', shift, ORDER));

      expect(result.current.marked).toEqual(['a', 'c', 'd', 'e']);
    });

    it('marks nothing twice where ranges overlap', () => {
      const { result } = marking();
      act(() => void result.current.click('a', ctrl, ORDER));
      act(() => void result.current.click('c', shift, ORDER));
      act(() => void result.current.click('b', shift, ORDER));

      expect(result.current.marked).toEqual(['a', 'b', 'c']);
    });

    // Nothing to measure from, so it behaves as the plain click it most resembles.
    it('does nothing surprising before anything has been touched', () => {
      const { result } = marking();

      act(() => void result.current.click('c', shift, ORDER));

      expect(result.current.marked).toEqual([]);
    });

    /**
     * The bug this was reported as (#63). The sidebar groups sessions - favourites, in
     * memory, the rest - and folds groups away, so the rows between two others on screen
     * are nothing like the rows between them in the list the app holds. A range across five
     * favourites also marked two sessions from the group below.
     */
    it('spans the rows as drawn rather than as the app holds them', () => {
      const { result } = marking();
      // Drawn in a different order, and with two rows the list has that nobody can see.
      const asDrawn = ['e', 'b', 'c'];

      act(() => void result.current.click('e', plain, asDrawn));
      act(() => void result.current.click('c', shift, asDrawn));

      expect(result.current.marked).toEqual(['e', 'b', 'c']);
    });

    it('reaches nothing that is not drawn', () => {
      const { result } = marking();
      // A folded group draws none of its rows, so they are not between anything.
      const asDrawn = ['a', 'b'];

      act(() => void result.current.click('a', plain, asDrawn));
      act(() => void result.current.click('b', shift, asDrawn));

      expect(result.current.marked).toEqual(['a', 'b']);
    });

    it('does nothing where the row clicked is not drawn at all', () => {
      const { result } = marking();

      act(() => void result.current.click('a', plain, ['a', 'b']));
      act(() => void result.current.click('e', shift, ['a', 'b']));

      expect(result.current.marked).toEqual([]);
    });
  });

  it('forgets a session that has left the list', () => {
    const view = marking();
    act(() => void view.result.current.click('b', ctrl, ORDER));
    act(() => void view.result.current.click('d', ctrl, ORDER));

    view.rerender({ rows: ['a', 'b', 'c'] });

    expect(view.result.current.marked).toEqual(['b']);
  });

  it('leaves the marks alone when the list has not lost anything', () => {
    const view = marking();
    act(() => void view.result.current.click('b', ctrl, ORDER));

    view.rerender({ rows: [...ORDER, 'f'] });

    expect(view.result.current.marked).toEqual(['b']);
  });

  it('can be cleared outright', () => {
    const { result } = marking();
    act(() => void result.current.click('b', ctrl, ORDER));

    act(() => result.current.clear());

    expect(result.current.marked).toEqual([]);
  });
});

/**
 * A Shift-click before anything has been touched (#63).
 *
 * The reader means the row they are looking at: they opened a session, then reached down
 * the list holding Shift. Without a fallback the first such click did nothing but clear
 * the marks and open whatever was under the pointer, which is how it was reported.
 */
describe('a range measured from the open session', () => {
  it('spans from what is open when nothing has been touched', () => {
    const { result } = renderHook(() => useMarked(ORDER, 'b'));

    act(() => void result.current.click('d', shift, ORDER));

    expect(result.current.marked).toEqual(['b', 'c', 'd']);
  });

  it('prefers a row that was actually touched', () => {
    const { result } = renderHook(() => useMarked(ORDER, 'a'));
    act(() => void result.current.click('c', plain, ORDER));

    act(() => void result.current.click('d', shift, ORDER));

    expect(result.current.marked).toEqual(['c', 'd']);
  });

  it('still does nothing where there is no open session either', () => {
    const { result } = renderHook(() => useMarked(ORDER, null));

    act(() => void result.current.click('c', shift, ORDER));

    expect(result.current.marked).toEqual([]);
  });

  it('does nothing where the open session is not drawn', () => {
    const { result } = renderHook(() => useMarked(ORDER, 'e'));

    act(() => void result.current.click('b', shift, ['a', 'b']));

    expect(result.current.marked).toEqual([]);
  });
});

/**
 * Picking over the list rather than reading it (#63).
 *
 * Asked for by name, because a plain click meaning something else is a large thing to do to
 * a list silently. Once in it the rows grow boxes and every click adds one, which is the
 * only form of this that somebody who has never met Ctrl-click can find.
 */
describe('picking over the list', () => {
  it('is off until it is asked for', () => {
    expect(marking().result.current.selecting).toBe(false);
  });

  it('keeps the session it was asked about', () => {
    const { result } = marking();

    act(() => result.current.start('c'));

    expect(result.current.selecting).toBe(true);
    expect(result.current.marked).toEqual(['c']);
  });

  it('adds a row already marked rather than taking it back', () => {
    const { result } = marking();
    act(() => void result.current.click('c', ctrl, ORDER));

    act(() => result.current.start('c'));

    expect(result.current.marked).toEqual(['c']);
  });

  it('takes a plain click as marking', () => {
    const { result } = marking();
    act(() => result.current.start('a'));

    act(() => void result.current.click('d', plain, ORDER));

    expect(result.current.marked).toEqual(['a', 'd']);
  });

  it('says a plain click was handled, so no session is opened by it', () => {
    const { result } = marking();
    act(() => result.current.start('a'));

    let handled = false;
    act(() => {
      handled = result.current.click('d', plain, ORDER);
    });

    expect(handled).toBe(true);
  });

  it('takes a row back when it is clicked again', () => {
    const { result } = marking();
    act(() => result.current.start('a'));
    act(() => void result.current.click('d', plain, ORDER));

    act(() => void result.current.click('a', plain, ORDER));

    expect(result.current.marked).toEqual(['d']);
  });

  it('still spans a range on Shift', () => {
    const { result } = marking();
    act(() => result.current.start('b'));

    act(() => void result.current.click('d', shift, ORDER));

    expect(result.current.marked).toEqual(['b', 'c', 'd']);
  });

  /** Nothing picked is not a selection, and a list where clicking opens nothing is a trap. */
  it('leaves when the last row is taken back', () => {
    const { result } = marking();
    act(() => result.current.start('a'));

    act(() => void result.current.click('a', plain, ORDER));

    expect(result.current.selecting).toBe(false);
    expect(result.current.marked).toEqual([]);
  });

  it('leaves when every picked row goes from the list', () => {
    const view = marking();
    act(() => view.result.current.start('d'));

    view.rerender({ rows: ['a', 'b', 'c'] });

    expect(view.result.current.selecting).toBe(false);
  });

  it('stays while some of what was picked is still there', () => {
    const view = marking();
    act(() => view.result.current.start('b'));
    act(() => void view.result.current.click('d', plain, ORDER));

    view.rerender({ rows: ['a', 'b', 'c'] });

    expect(view.result.current.selecting).toBe(true);
    expect(view.result.current.marked).toEqual(['b']);
  });

  it('leaves when it is finished with', () => {
    const { result } = marking();
    act(() => result.current.start('a'));

    act(() => result.current.clear());

    expect(result.current.selecting).toBe(false);
    expect(result.current.marked).toEqual([]);
  });

  it('leaves on Escape, as every other mode does', () => {
    const { result } = marking();
    act(() => result.current.start('a'));

    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(result.current.selecting).toBe(false);
    expect(result.current.marked).toEqual([]);
  });

  /** The key belongs to whatever dialog or menu is open when nobody is picking rows. */
  it('answers no key while it is off', () => {
    const { result } = marking();
    act(() => void result.current.click('b', ctrl, ORDER));

    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(result.current.marked).toEqual(['b']);
  });

  it('lets go of the key once it has left', () => {
    const { result, unmount } = marking();
    act(() => result.current.start('a'));
    act(() => result.current.clear());

    // Nothing to assert beyond it not throwing: a listener left behind would answer a key
    // pressed in a list nobody is picking over.
    expect(() => unmount()).not.toThrow();
  });
});
