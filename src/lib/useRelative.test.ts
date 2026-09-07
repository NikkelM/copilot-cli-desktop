// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useRelative } from './useRelative';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

afterEach(() => vi.useRealTimers());

/**
 * A row drawn as "1s ago" and left alone said so for as long as the window stayed open,
 * which is worse than stale: it is a wrong answer stated confidently.
 */
describe('useRelative', () => {
  it('says how long ago something was', () => {
    const { result } = renderHook(() => useRelative(ago(7_200_000)));
    expect(result.current).toBe('2h ago');
  });

  it('follows a recent time as it ages', () => {
    vi.useFakeTimers();
    const iso = new Date(Date.now() - 5000).toISOString();
    const { result } = renderHook(() => useRelative(iso));

    // The clock has to move as well as the timers: what it reports is a difference from
    // now, and advancing timers moves the mocked clock along with them.
    act(() => {
      vi.setSystemTime(Date.now() + 60_000);
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current).toBe('2m ago');
  });

  // Past an hour the answer changes once an hour at most, so a transcript of a hundred old
  // messages should cost no timers at all.
  it('stops following something that has stopped changing', () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();

    renderHook(() => useRelative(ago(7_200_000)));

    expect(vi.getTimerCount()).toBe(before);
  });

  it('follows nothing when there is no time to follow', () => {
    vi.useFakeTimers();
    renderHook(() => useRelative(undefined));

    expect(vi.getTimerCount()).toBe(0);
  });

  it('says nothing when there is no time to say', () => {
    const { result } = renderHook(() => useRelative(undefined));
    expect(result.current).toBe('');
  });

  it('stops its clock when the row is gone', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useRelative(ago(5000)));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
