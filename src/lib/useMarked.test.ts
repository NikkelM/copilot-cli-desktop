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

    act(() => void result.current.click('b', ctrl));

    expect(result.current.marked).toEqual(['b']);
  });

  it('gathers several, one ctrl-click at a time', () => {
    const { result } = marking();

    act(() => void result.current.click('b', ctrl));
    act(() => void result.current.click('d', ctrl));

    expect(result.current.marked).toEqual(['b', 'd']);
  });

  it('takes one back off when it is ctrl-clicked again', () => {
    const { result } = marking();
    act(() => void result.current.click('b', ctrl));

    act(() => void result.current.click('b', ctrl));

    expect(result.current.marked).toEqual([]);
  });

  /** A plain click is about going somewhere, and arriving ends what was being gathered. */
  it('clears everything on an ordinary click', () => {
    const { result } = marking();
    act(() => void result.current.click('b', ctrl));

    act(() => void result.current.click('d', plain));

    expect(result.current.marked).toEqual([]);
  });

  it('says an ordinary click was not handled as marking', () => {
    const { result } = marking();
    let handled = true;

    act(() => {
      handled = result.current.click('b', plain);
    });

    expect(handled).toBe(false);
  });

  it('says a ctrl-click was', () => {
    const { result } = marking();
    let handled = false;

    act(() => {
      handled = result.current.click('b', ctrl);
    });

    expect(handled).toBe(true);
  });

  describe('a range', () => {
    it('marks everything between the last row touched and this one', () => {
      const { result } = marking();
      act(() => void result.current.click('b', plain));

      act(() => void result.current.click('d', shift));

      expect(result.current.marked).toEqual(['b', 'c', 'd']);
    });

    it('reaches backwards as readily as forwards', () => {
      const { result } = marking();
      act(() => void result.current.click('d', plain));

      act(() => void result.current.click('b', shift));

      expect(result.current.marked).toEqual(['b', 'c', 'd']);
    });

    it('adds to what was already marked rather than replacing it', () => {
      const { result } = marking();
      act(() => void result.current.click('a', ctrl));
      act(() => void result.current.click('c', ctrl));

      act(() => void result.current.click('e', shift));

      expect(result.current.marked).toEqual(['a', 'c', 'd', 'e']);
    });

    it('marks nothing twice where ranges overlap', () => {
      const { result } = marking();
      act(() => void result.current.click('a', ctrl));
      act(() => void result.current.click('c', shift));
      act(() => void result.current.click('b', shift));

      expect(result.current.marked).toEqual(['a', 'b', 'c']);
    });

    // Nothing to measure from, so it behaves as the plain click it most resembles.
    it('does nothing surprising before anything has been touched', () => {
      const { result } = marking();

      act(() => void result.current.click('c', shift));

      expect(result.current.marked).toEqual([]);
    });
  });

  it('forgets a session that has left the list', () => {
    const view = marking();
    act(() => void view.result.current.click('b', ctrl));
    act(() => void view.result.current.click('d', ctrl));

    view.rerender({ rows: ['a', 'b', 'c'] });

    expect(view.result.current.marked).toEqual(['b']);
  });

  it('leaves the marks alone when the list has not lost anything', () => {
    const view = marking();
    act(() => void view.result.current.click('b', ctrl));

    view.rerender({ rows: [...ORDER, 'f'] });

    expect(view.result.current.marked).toEqual(['b']);
  });

  it('can be cleared outright', () => {
    const { result } = marking();
    act(() => void result.current.click('b', ctrl));

    act(() => result.current.clear());

    expect(result.current.marked).toEqual([]);
  });
});
