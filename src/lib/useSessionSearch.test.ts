// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionSearch } from './useSessionSearch';

const { searchSessions } = vi.hoisted(() => ({ searchSessions: vi.fn() }));
vi.mock('./sidecar', () => ({ searchSessions: (query: string) => searchSessions(query) }));

const match = (sessionId: string) => ({ sessionId, excerpt: 'said it', turn: 2 });

beforeEach(() => {
  vi.useFakeTimers();
  searchSessions.mockReset().mockResolvedValue([match('one')]);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Settling the timer and letting the reply land, which are two different waits. */
const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
};

describe('searching what sessions said', () => {
  it('asks once the typing stops', async () => {
    const { result } = renderHook(() => useSessionSearch('eviction'));

    expect(searchSessions).not.toHaveBeenCalled();
    await settle();

    expect(searchSessions).toHaveBeenCalledExactlyOnceWith('eviction');
    expect(result.current.get('one')).toEqual(match('one'));
  });

  // Holding a key down should not queue a request per character.
  it('asks only for what was left on screen', async () => {
    const { rerender } = renderHook(({ q }) => useSessionSearch(q), { initialProps: { q: 'evi' } });
    rerender({ q: 'evic' });
    rerender({ q: 'eviction' });

    await settle();

    expect(searchSessions).toHaveBeenCalledExactlyOnceWith('eviction');
  });

  /**
   * One or two characters match nearly everything ever said, which would put the whole list
   * back on screen looking like a result.
   */
  it('asks nothing for a query too short to mean anything', async () => {
    renderHook(() => useSessionSearch('ev'));
    await settle();

    expect(searchSessions).not.toHaveBeenCalled();
  });

  it('asks nothing when the box is emptied', async () => {
    const { result, rerender } = renderHook(({ q }) => useSessionSearch(q), {
      initialProps: { q: 'eviction' },
    });
    await settle();
    expect(result.current.size).toBe(1);

    rerender({ q: '' });

    expect(result.current.size).toBe(0);
  });

  // Rows emptying and refilling on every keystroke reads as the search breaking.
  it('keeps what it found while the next answer is on its way', async () => {
    const { result, rerender } = renderHook(({ q }) => useSessionSearch(q), {
      initialProps: { q: 'eviction' },
    });
    await settle();
    expect(result.current.size).toBe(1);

    rerender({ q: 'eviction rule' });

    expect(result.current.get('one')).toBeTruthy();
  });

  it('leaves the list filtered by name alone when the search cannot run', async () => {
    searchSessions.mockRejectedValue(new Error('no database'));
    const { result } = renderHook(() => useSessionSearch('eviction'));

    await settle();

    expect(result.current.size).toBe(0);
  });

  // A reply for a query nobody is looking at any more must not land on the one they are.
  it('drops an answer for a query that has been typed past', async () => {
    let settleFirst: (value: unknown) => void = () => {};
    searchSessions.mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)));
    searchSessions.mockResolvedValueOnce([match('second')]);

    const { result, rerender } = renderHook(({ q }) => useSessionSearch(q), {
      initialProps: { q: 'first query' },
    });
    await settle();

    rerender({ q: 'second query' });
    await settle();
    await act(async () => {
      settleFirst([match('first')]);
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.has('first')).toBe(false);
    expect(result.current.has('second')).toBe(true);
  });
});
