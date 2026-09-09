// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useElapsed, useNow, useRemaining } from './useElapsed';

const START = new Date('2024-01-01T00:00:00.000Z');
const at = (seconds: number) => new Date(START.getTime() + seconds * 1000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the clock only while something is running', () => {
  /**
   * The whole reason this is a hook per row: an idle app must not wake up once a second,
   * and neither must the hundred finished rows above the running one.
   */
  it('runs no timer at all when nothing is moving', () => {
    renderHook(() => useNow(false));

    expect(vi.getTimerCount()).toBe(0);
  });

  it('ticks once a second while something is', () => {
    const { result } = renderHook(() => useNow(true));

    expect(result.current).toBe(START.getTime());
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe(START.getTime() + 1000);
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current).toBe(START.getTime() + 3000);
  });

  it('stops when it is asked to, rather than leaving the timer behind', () => {
    const { rerender } = renderHook(({ active }) => useNow(active), { initialProps: { active: true } });
    expect(vi.getTimerCount()).toBe(1);

    rerender({ active: false });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves nothing running once the row is gone', () => {
    const { unmount } = renderHook(() => useNow(true));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * The value is read at mount and then only on a tick, so a hook that starts counting
   * after a spell of idleness would otherwise report a time from before it.
   */
  it('catches up as soon as it starts, without waiting for the first tick', () => {
    const { result, rerender } = renderHook(({ active }) => useNow(active), { initialProps: { active: false } });

    act(() => void vi.advanceTimersByTime(30_000));
    rerender({ active: true });

    expect(result.current).toBe(START.getTime() + 30_000);
  });
});

describe('counting how long something has taken', () => {
  it('counts up while it is still going', () => {
    const { result } = renderHook(() => useElapsed(at(0)));

    expect(result.current).toBe(0);
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current).toBe(5000);
  });

  it('holds still, and costs nothing, once it is over', () => {
    const { result } = renderHook(() => useElapsed(at(0), at(3)));

    expect(result.current).toBe(3000);
    expect(vi.getTimerCount()).toBe(0);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(3000);
  });

  it('has nothing to say about something that never started', () => {
    expect(renderHook(() => useElapsed(null)).result.current).toBeNull();
    expect(renderHook(() => useElapsed(undefined)).result.current).toBeNull();
    expect(renderHook(() => useElapsed('not a date')).result.current).toBeNull();
  });

  /** Clocks disagree, and a duration that reads as negative is worse than one that reads as zero. */
  it('never counts backwards, however the timestamps land', () => {
    expect(renderHook(() => useElapsed(at(10))).result.current).toBe(0);
    expect(renderHook(() => useElapsed(at(10), at(4))).result.current).toBe(0);
  });

  it('counts from the start when the end is unreadable, rather than giving up', () => {
    const { result } = renderHook(() => useElapsed(at(0), 'not a date'));

    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current).toBe(2000);
  });
});

describe('counting down to a deadline', () => {
  it('counts down while there is time left', () => {
    const { result } = renderHook(() => useRemaining(at(60)));

    expect(result.current).toBe(60_000);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(result.current).toBe(40_000);
  });

  /** Zero is the answer, not a negative overrun: the request has already answered itself. */
  it('stops at zero rather than going past it', () => {
    const { result } = renderHook(() => useRemaining(at(5)));

    act(() => void vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(0);
  });

  it('has nothing to say, and runs nothing, without a deadline', () => {
    const { result } = renderHook(() => useRemaining(null));

    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has nothing to say about a deadline it cannot read', () => {
    expect(renderHook(() => useRemaining('not a date')).result.current).toBeNull();
  });
});
