// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useTaskbar } from './useTaskbar';

const setProgressBar = vi.fn(() => Promise.resolve());

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setProgressBar }),
  ProgressBarStatus: { Normal: 'normal', None: 'none', Indeterminate: 'indeterminate' },
}));

beforeEach(() => setProgressBar.mockClear());

describe('the taskbar button while a session works', () => {
  it('paints while something is working', () => {
    renderHook(() => useTaskbar(true));

    expect(setProgressBar).toHaveBeenCalledWith({ status: 'indeterminate' });
  });

  it('clears when nothing is', () => {
    renderHook(() => useTaskbar(false));

    expect(setProgressBar).toHaveBeenCalledWith({ status: 'none' });
  });

  it('clears once the last session finishes', () => {
    const { rerender } = renderHook(({ working }) => useTaskbar(working), {
      initialProps: { working: true },
    });

    rerender({ working: false });

    expect(setProgressBar).toHaveBeenLastCalledWith({ status: 'none' });
  });

  /** Renders happen constantly; the taskbar is a Win32 call and should not follow them. */
  it('does not repaint while the answer is unchanged', () => {
    const { rerender } = renderHook(({ working }) => useTaskbar(working), {
      initialProps: { working: true },
    });

    rerender({ working: true });
    rerender({ working: true });

    expect(setProgressBar).toHaveBeenCalledTimes(1);
  });

  /** A window that has gone, or a platform with no taskbar, is not worth a banner. */
  it('swallows a failure rather than surfacing it', () => {
    setProgressBar.mockRejectedValueOnce(new Error('no such window'));

    expect(() => renderHook(() => useTaskbar(true))).not.toThrow();
  });
});

/**
 * The CLI paints the same taskbar button and has a switch for it, so a reader who turned
 * it off there meant both rather than only the one they turned it off in (#205).
 */
describe('when the CLI says not to paint the taskbar', () => {
  it('paints nothing even while a session works', () => {
    renderHook(() => useTaskbar(true, false));

    expect(setProgressBar).toHaveBeenCalledWith({ status: 'none' });
  });

  it('paints when the CLI does not say otherwise', () => {
    renderHook(() => useTaskbar(true));

    expect(setProgressBar).toHaveBeenCalledWith({ status: 'indeterminate' });
  });

  // The switch moving is as much a reason to repaint as the work starting or stopping.
  it('stops painting the moment it is turned off', () => {
    const { rerender } = renderHook(({ wanted }) => useTaskbar(true, wanted), {
      initialProps: { wanted: true },
    });
    setProgressBar.mockClear();

    rerender({ wanted: false });

    expect(setProgressBar).toHaveBeenCalledWith({ status: 'none' });
  });
});

/**
 * The detail that makes the bar move rather than fill (#272).
 *
 * `tao` sets the state, and then calls `SetProgressValue` only if a progress value came
 * with it - and a value puts the button back to a normal filled bar. So the marquee is not
 * only a matter of asking for the right status: it is also a matter of sending no number
 * alongside it, which is easy to add back in good faith.
 */
describe('asking for a bar that moves', () => {
  it('sends no progress value, which would fill it instead', () => {
    renderHook(() => useTaskbar(true));

    expect(setProgressBar).toHaveBeenCalledWith({ status: 'indeterminate' });
  });
});