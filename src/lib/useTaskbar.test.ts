// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useTaskbar } from './useTaskbar';

const setProgressBar = vi.fn(() => Promise.resolve());

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setProgressBar }),
  ProgressBarStatus: { Normal: 'normal', None: 'none' },
}));

beforeEach(() => setProgressBar.mockClear());

describe('the taskbar button while a session works', () => {
  it('paints while something is working', () => {
    renderHook(() => useTaskbar(true));

    expect(setProgressBar).toHaveBeenCalledWith({ status: 'normal', progress: 100 });
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
