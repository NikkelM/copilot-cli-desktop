// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useCopy } from './useCopy';

const copyText = vi.hoisted(() => vi.fn());
vi.mock('./clipboard', () => ({ copyText }));

/** How long the confirmation stays up, per the hook. */
const CONFIRM_MS = 1200;

beforeEach(() => {
  vi.useFakeTimers();
  copyText.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the copy promise settle while the clock is frozen. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('copying, and saying that it happened', () => {
  it('says nothing before anything is copied', () => {
    const { result } = renderHook(() => useCopy());

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe(false);
  });

  it('passes the text through', async () => {
    const { result } = renderHook(() => useCopy());
    act(() => result.current.copy('session-abc'));
    await settle();

    expect(copyText).toHaveBeenCalledWith('session-abc');
  });

  it('confirms a copy that worked', async () => {
    const { result } = renderHook(() => useCopy());
    act(() => result.current.copy('ok'));
    await settle();

    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('reports a copy that did not', async () => {
    copyText.mockResolvedValue(false);
    const { result } = renderHook(() => useCopy());
    act(() => result.current.copy('nope'));
    await settle();

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe(true);
  });

  it('clears the confirmation once it has been read', async () => {
    const { result } = renderHook(() => useCopy());
    act(() => result.current.copy('ok'));
    await settle();
    act(() => void vi.advanceTimersByTime(CONFIRM_MS));

    expect(result.current.copied).toBe(false);
  });

  it('clears a failure too, rather than leaving it up forever', async () => {
    copyText.mockResolvedValue(false);
    const { result } = renderHook(() => useCopy());
    act(() => result.current.copy('nope'));
    await settle();
    act(() => void vi.advanceTimersByTime(CONFIRM_MS));

    expect(result.current.failed).toBe(false);
  });

  it('holds the confirmation right up to the deadline', async () => {
    const { result } = renderHook(() => useCopy());
    act(() => result.current.copy('ok'));
    await settle();
    act(() => void vi.advanceTimersByTime(CONFIRM_MS - 1));

    expect(result.current.copied).toBe(true);
  });

  // Pressing twice is what someone does when they are not sure the first press took, so
  // the second press has to restart the confirmation rather than inherit the first's
  // remaining time and vanish immediately.
  it('restarts the countdown on a second copy', async () => {
    const { result } = renderHook(() => useCopy());
    act(() => result.current.copy('one'));
    await settle();

    act(() => void vi.advanceTimersByTime(CONFIRM_MS - 100));
    act(() => result.current.copy('two'));
    await settle();
    act(() => void vi.advanceTimersByTime(CONFIRM_MS - 100));

    expect(result.current.copied).toBe(true);
  });

  it('replaces a failure with a success rather than showing both', async () => {
    copyText.mockResolvedValue(false);
    const { result } = renderHook(() => useCopy());
    act(() => result.current.copy('nope'));
    await settle();

    copyText.mockResolvedValue(true);
    act(() => result.current.copy('ok'));
    await settle();

    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  // A confirmation still counting down when the row is gone would fire on nothing.
  it('drops a pending countdown on unmount', async () => {
    const { result, unmount } = renderHook(() => useCopy());
    act(() => result.current.copy('ok'));
    await settle();

    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs no timer until something is copied', () => {
    renderHook(() => useCopy());

    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the same copy function across renders, so a button does not remount', () => {
    const { result, rerender } = renderHook(() => useCopy());
    const before = result.current.copy;
    rerender();

    expect(result.current.copy).toBe(before);
  });
});
