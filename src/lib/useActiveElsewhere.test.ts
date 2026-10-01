// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { activeSessions } = vi.hoisted(() => ({ activeSessions: vi.fn() }));
vi.mock('./sidecar', () => ({ activeSessions: () => activeSessions() }));

import { useActiveElsewhere } from './useActiveElsewhere';

beforeEach(() => {
  vi.useFakeTimers();
  activeSessions.mockReset().mockResolvedValue(['s1']);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let a resolved promise reach the hook while the clock is held still. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/**
 * Which sessions another Copilot has open (#63).
 *
 * Nothing announces one starting or stopping, so this is the one thing in the app that has
 * to ask on a timer.
 */
describe('watching for another Copilot', () => {
  it('asks as soon as it is watching', async () => {
    renderHook(() => useActiveElsewhere());

    await settle();

    expect(activeSessions).toHaveBeenCalled();
  });

  it('hands back what it was told', async () => {
    const { result } = renderHook(() => useActiveElsewhere());

    await settle();

    expect(result.current.active).toEqual(['s1']);
  });

  it('says nothing before the first answer arrives', () => {
    const { result } = renderHook(() => useActiveElsewhere());

    expect(result.current.active).toEqual([]);
  });

  it('asks again as time passes', async () => {
    renderHook(() => useActiveElsewhere());
    await settle();
    activeSessions.mockClear();

    act(() => void vi.advanceTimersByTime(20_000));

    expect(activeSessions).toHaveBeenCalledOnce();
  });

  it('notices one that has since been closed', async () => {
    const { result } = renderHook(() => useActiveElsewhere());
    await settle();
    activeSessions.mockResolvedValue([]);

    act(() => void vi.advanceTimersByTime(20_000));
    await settle();

    expect(result.current.active).toEqual([]);
  });

  it('can be asked again without waiting', async () => {
    const { result } = renderHook(() => useActiveElsewhere());
    await settle();
    activeSessions.mockClear();

    act(() => result.current.refresh());

    expect(activeSessions).toHaveBeenCalledOnce();
  });

  /** A warning nobody asked for is not worth interrupting anybody about. */
  it('says nothing rather than failing when it cannot find out', async () => {
    activeSessions.mockRejectedValue(new Error('no sidecar'));
    const { result } = renderHook(() => useActiveElsewhere());

    await settle();

    expect(result.current.active).toEqual([]);
  });

  it('stops asking once nobody is watching', async () => {
    const { unmount } = renderHook(() => useActiveElsewhere());
    await settle();
    activeSessions.mockClear();

    unmount();
    act(() => void vi.advanceTimersByTime(60_000));

    expect(activeSessions).not.toHaveBeenCalled();
  });
});
