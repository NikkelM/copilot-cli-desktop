// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useNotesColumn } from './useNotesColumn';
import type { WikiPage } from '../../shared/protocol';

const NOTES: WikiPage[] = [{ path: 'a.md', title: 'A' }];

describe('whether a note is drawn beside the session', () => {
  it('is not, before anybody has asked for one', () => {
    const { result } = renderHook(() => useNotesColumn('one', NOTES));

    expect(result.current.open).toBe(false);
  });

  it('is once it has been asked for', () => {
    const { result } = renderHook(() => useNotesColumn('one', NOTES));

    act(() => result.current.show());

    expect(result.current.open).toBe(true);
  });

  it('is not again once it has been closed', () => {
    const { result } = renderHook(() => useNotesColumn('one', NOTES));
    act(() => result.current.show());

    act(() => result.current.hide());

    expect(result.current.open).toBe(false);
  });

  /** A column with nothing in it is not a column, whatever anybody asked for. */
  it('is not for a session with no notes, even when one was asked for', () => {
    const { result } = renderHook(() => useNotesColumn('one', []));

    act(() => result.current.show());

    expect(result.current.open).toBe(false);
  });

  /**
   * Asked rather than stored, so a session whose notes have gone - retagged, or the page
   * deleted - cannot leave an empty column behind.
   */
  it('closes itself when the notes it was showing go away', () => {
    const { result, rerender } = renderHook(({ notes }) => useNotesColumn('one', notes), {
      initialProps: { notes: NOTES },
    });
    act(() => result.current.show());

    rerender({ notes: [] });

    expect(result.current.open).toBe(false);
  });

  it('comes back when they do, without being asked again', () => {
    const { result, rerender } = renderHook(({ notes }) => useNotesColumn('one', notes), {
      initialProps: { notes: NOTES },
    });
    act(() => result.current.show());
    rerender({ notes: [] });

    rerender({ notes: NOTES });

    expect(result.current.open).toBe(true);
  });
});

/**
 * A note is open because of what the session is about, so it does not follow the reader to
 * the next one. The panels under the transcript already work this way.
 */
describe('moving to another session', () => {
  it('closes it', () => {
    const { result, rerender } = renderHook(({ id }) => useNotesColumn(id, NOTES), {
      initialProps: { id: 'one' },
    });
    act(() => result.current.show());

    rerender({ id: 'two' });

    expect(result.current.open).toBe(false);
  });

  it('closes it when the reader goes to no session at all', () => {
    const { result, rerender } = renderHook(({ id }) => useNotesColumn(id, NOTES), {
      initialProps: { id: 'one' as string | null },
    });
    act(() => result.current.show());

    rerender({ id: null });

    expect(result.current.open).toBe(false);
  });

  /** Coming back is not asking for it again, which is the rule usePanel already keeps. */
  it('leaves it closed on coming back', () => {
    const { result, rerender } = renderHook(({ id }) => useNotesColumn(id, NOTES), {
      initialProps: { id: 'one' },
    });
    act(() => result.current.show());
    rerender({ id: 'two' });

    rerender({ id: 'one' });

    expect(result.current.open).toBe(false);
  });

  it('leaves it alone while the reader stays where they are', () => {
    const { result, rerender } = renderHook(({ id }) => useNotesColumn(id, NOTES), {
      initialProps: { id: 'one' },
    });
    act(() => result.current.show());

    rerender({ id: 'one' });

    expect(result.current.open).toBe(true);
  });
});

/**
 * The browser takes the whole pane, and a note beside it would be the wiki twice over. It
 * stands the column down rather than closing it, so coming back brings it with it.
 */
describe('while the whole browser is up', () => {
  it('draws no column beside it', () => {
    const { result, rerender } = renderHook(({ browsing }) => useNotesColumn('one', NOTES, browsing), {
      initialProps: { browsing: false },
    });
    act(() => result.current.show());

    rerender({ browsing: true });

    expect(result.current.open).toBe(false);
  });

  it('brings it back on returning to the session', () => {
    const { result, rerender } = renderHook(({ browsing }) => useNotesColumn('one', NOTES, browsing), {
      initialProps: { browsing: false },
    });
    act(() => result.current.show());
    rerender({ browsing: true });

    rerender({ browsing: false });

    expect(result.current.open).toBe(true);
  });

  /** Going to the browser is not asking for a column that was never open. */
  it('brings nothing back for a session whose notes were closed', () => {
    const { result, rerender } = renderHook(({ browsing }) => useNotesColumn('one', NOTES, browsing), {
      initialProps: { browsing: true },
    });

    rerender({ browsing: false });

    expect(result.current.open).toBe(false);
  });

  it('can still be closed from behind the browser', () => {
    const { result, rerender } = renderHook(({ browsing }) => useNotesColumn('one', NOTES, browsing), {
      initialProps: { browsing: false },
    });
    act(() => result.current.show());
    rerender({ browsing: true });

    act(() => result.current.hide());
    rerender({ browsing: false });

    expect(result.current.open).toBe(false);
  });

  /** Moving session closes it, and the browser does not keep it alive behind that. */
  it('does not survive a change of session made while browsing', () => {
    const { result, rerender } = renderHook(({ id, browsing }) => useNotesColumn(id, NOTES, browsing), {
      initialProps: { id: 'one', browsing: false },
    });
    act(() => result.current.show());
    rerender({ id: 'one', browsing: true });

    rerender({ id: 'two', browsing: false });

    expect(result.current.open).toBe(false);
  });
});

describe('not redrawing for nothing', () => {
  it('hands back the same controls across renders', () => {
    const { result, rerender } = renderHook(() => useNotesColumn('one', NOTES));
    const { show, hide } = result.current;

    rerender();

    expect(result.current.show).toBe(show);
    expect(result.current.hide).toBe(hide);
  });
});
