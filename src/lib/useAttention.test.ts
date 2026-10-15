// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useAttention } from './useAttention';

const requestUserAttention = vi.fn(() => Promise.resolve());

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ requestUserAttention }),
  UserAttentionType: { Critical: 1, Informational: 2 },
}));

beforeEach(() => requestUserAttention.mockClear());

describe('flashing the taskbar for a session that stopped to ask', () => {
  it('flashes when a session starts waiting', () => {
    const { rerender } = renderHook(({ waiting }) => useAttention(waiting), {
      initialProps: { waiting: 0 },
    });

    rerender({ waiting: 1 });

    expect(requestUserAttention).toHaveBeenLastCalledWith(1);
  });

  /** Critical keeps flashing until the app is focused, which is how long the session waits. */
  it('asks for the kind that does not stop on its own', () => {
    renderHook(() => useAttention(1));

    expect(requestUserAttention).toHaveBeenCalledWith(1);
  });

  it('flashes again when a second session starts waiting', () => {
    const { rerender } = renderHook(({ waiting }) => useAttention(waiting), {
      initialProps: { waiting: 1 },
    });
    requestUserAttention.mockClear();

    rerender({ waiting: 2 });

    expect(requestUserAttention).toHaveBeenCalledTimes(1);
  });

  /**
   * A flash already running needs no restarting, and renders happen constantly where this
   * is a Win32 call.
   */
  it('does not flash again while the number is unchanged', () => {
    const { rerender } = renderHook(({ waiting }) => useAttention(waiting), {
      initialProps: { waiting: 1 },
    });
    requestUserAttention.mockClear();

    rerender({ waiting: 1 });

    expect(requestUserAttention).not.toHaveBeenCalled();
  });

  /** One of two answered still leaves one waiting, so nothing is cleared and nothing re-flashes. */
  it('says nothing when one of several is answered', () => {
    const { rerender } = renderHook(({ waiting }) => useAttention(waiting), {
      initialProps: { waiting: 2 },
    });
    requestUserAttention.mockClear();

    rerender({ waiting: 1 });

    expect(requestUserAttention).not.toHaveBeenCalled();
  });

  /**
   * Unset explicitly rather than trusting the window manager, which the Tauri API warns may
   * leave the request standing even after the window has taken input.
   */
  it('takes the request back once the last one is answered', () => {
    const { rerender } = renderHook(({ waiting }) => useAttention(waiting), {
      initialProps: { waiting: 1 },
    });
    requestUserAttention.mockClear();

    rerender({ waiting: 0 });

    expect(requestUserAttention).toHaveBeenCalledWith(null);
  });

  it('says nothing at all while nothing is waiting', () => {
    renderHook(() => useAttention(0));

    expect(requestUserAttention).not.toHaveBeenCalled();
  });

  /** A question left unanswered from a previous run is still owed, so it is still said. */
  it('flashes for a session already waiting when the app starts', () => {
    renderHook(() => useAttention(1));

    expect(requestUserAttention).toHaveBeenCalledWith(1);
  });
});
