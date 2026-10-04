// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionPreviews } from './useSessionPreviews';

const sessionPreviews = vi.fn();

vi.mock('./sidecar', () => ({
  sessionPreviews: (ids: string[]) => sessionPreviews(ids),
}));

beforeEach(() => {
  vi.useFakeTimers();
  sessionPreviews.mockReset().mockResolvedValue({ a: 'What a said' });
});

afterEach(() => vi.useRealTimers());

/** Let the timer fire and the answer land, which are two separate turns of the loop. */
async function settle() {
  await act(async () => {
    vi.runAllTimers();
    await Promise.resolve();
  });
}

describe('asking what the rows on screen last said', () => {
  it('asks about the rows it was given', async () => {
    renderHook(() => useSessionPreviews(['a'], 2));

    await settle();

    expect(sessionPreviews).toHaveBeenCalledWith(['a']);
  });

  it('hands back what came of it', async () => {
    const { result } = renderHook(() => useSessionPreviews(['a'], 2));

    await settle();

    expect(result.current).toEqual({ a: 'What a said' });
  });

  it('starts with nothing, before anything has been read', () => {
    const { result } = renderHook(() => useSessionPreviews(['a'], 2));

    expect(result.current).toEqual({});
  });

  it('waits for the list to settle rather than asking at once', () => {
    renderHook(() => useSessionPreviews(['a'], 2));

    expect(sessionPreviews).not.toHaveBeenCalled();
  });

  it('asks once for a list scrolled through quickly, not once a row', async () => {
    const { rerender } = renderHook(({ ids }) => useSessionPreviews(ids, 2), {
      initialProps: { ids: ['a'] },
    });
    rerender({ ids: ['b'] });
    rerender({ ids: ['c'] });

    await settle();

    expect(sessionPreviews).toHaveBeenCalledTimes(1);
    expect(sessionPreviews).toHaveBeenCalledWith(['c']);
  });

  it('says nothing rather than failing when the read does', async () => {
    sessionPreviews.mockRejectedValue(new Error('no such log'));
    const { result } = renderHook(() => useSessionPreviews(['a'], 2));

    await settle();

    expect(result.current).toEqual({});
  });
});

describe('not asking the same question twice', () => {
  it('treats the same rows in another order as the same question', async () => {
    const { rerender } = renderHook(({ ids }) => useSessionPreviews(ids, 2), {
      initialProps: { ids: ['a', 'b'] },
    });
    await settle();

    rerender({ ids: ['b', 'a'] });
    await settle();

    expect(sessionPreviews).toHaveBeenCalledTimes(1);
  });

  it('asks again once a different row comes into view', async () => {
    const { rerender } = renderHook(({ ids }) => useSessionPreviews(ids, 2), {
      initialProps: { ids: ['a'] },
    });
    await settle();

    rerender({ ids: ['a', 'b'] });
    await settle();

    expect(sessionPreviews).toHaveBeenCalledTimes(2);
  });

  it('asks again for the same rows given as a new array, only if it has to', async () => {
    const { rerender } = renderHook(({ ids }) => useSessionPreviews(ids, 2), {
      initialProps: { ids: ['a'] },
    });
    await settle();

    // What a scroll event produces: the same ids in a freshly built array.
    rerender({ ids: ['a'] });
    await settle();

    expect(sessionPreviews).toHaveBeenCalledTimes(1);
  });
});

describe('keeping what it already found', () => {
  it('adds to what it has rather than replacing it', async () => {
    const { result, rerender } = renderHook(({ ids }) => useSessionPreviews(ids, 2), {
      initialProps: { ids: ['a'] },
    });
    await settle();

    sessionPreviews.mockResolvedValue({ b: 'What b said' });
    rerender({ ids: ['b'] });
    await settle();

    expect(result.current).toEqual({ a: 'What a said', b: 'What b said' });
  });

  it('keeps what it found when the lines are turned off', async () => {
    const { result, rerender } = renderHook(({ lines }) => useSessionPreviews(['a'], lines), {
      initialProps: { lines: 2 },
    });
    await settle();

    rerender({ lines: 0 });

    expect(result.current).toEqual({ a: 'What a said' });
  });

  it('ignores an answer to a question that is no longer being asked', async () => {
    let answer: (found: Record<string, string>) => void = () => {};
    sessionPreviews.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { result, rerender } = renderHook(({ ids }) => useSessionPreviews(ids, 2), {
      initialProps: { ids: ['a'] },
    });
    act(() => void vi.runAllTimers());

    rerender({ ids: ['b'] });
    await act(async () => {
      answer({ a: 'Stale' });
      await Promise.resolve();
    });

    expect(result.current).toEqual({});
  });
});

describe('when nobody is drawing previews', () => {
  it('reads nothing at all at zero lines', async () => {
    renderHook(() => useSessionPreviews(['a', 'b'], 0));

    await settle();

    expect(sessionPreviews).not.toHaveBeenCalled();
  });

  it('reads nothing when no rows are on screen', async () => {
    renderHook(() => useSessionPreviews([], 2));

    await settle();

    expect(sessionPreviews).not.toHaveBeenCalled();
  });

  it('starts reading once the lines are turned back on', async () => {
    const { rerender } = renderHook(({ lines }) => useSessionPreviews(['a'], lines), {
      initialProps: { lines: 0 },
    });
    await settle();

    rerender({ lines: 2 });
    await settle();

    expect(sessionPreviews).toHaveBeenCalledWith(['a']);
  });
});
