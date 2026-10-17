// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { staleRuntime, onSidecarBehind, rebuildSidecar, restartRuntime, onSidecarStopped, onSidecarRestarted } =
  vi.hoisted(() => ({
    staleRuntime: vi.fn(),
    onSidecarBehind: vi.fn(),
    rebuildSidecar: vi.fn(),
    restartRuntime: vi.fn(),
    onSidecarStopped: vi.fn(),
    onSidecarRestarted: vi.fn(),
  }));

vi.mock('./protocolCheck', () => ({ staleRuntime: () => staleRuntime() }));
vi.mock('./sidecarFreshness', () => ({
  onSidecarBehind: (h: (m: string) => void) => onSidecarBehind(h),
  rebuildSidecar: () => rebuildSidecar(),
}));
vi.mock('./sidecar', () => ({
  restartRuntime: () => restartRuntime(),
  onSidecarStopped: (h: (r: string) => void) => onSidecarStopped(h),
  onSidecarRestarted: (h: () => void) => onSidecarRestarted(h),
}));

import { useRuntimeHealth } from './useRuntimeHealth';

/** The handler each subscription was given, so a test can fire what the runtime would. */
let fireStopped: (reason: string) => void;
let fireRestarted: () => void;
let fireBehind: (message: string) => void;

beforeEach(() => {
  staleRuntime.mockReset().mockResolvedValue(null);
  rebuildSidecar.mockReset().mockResolvedValue(undefined);
  restartRuntime.mockReset().mockResolvedValue(undefined);
  onSidecarStopped.mockReset().mockImplementation((h: typeof fireStopped) => {
    fireStopped = h;
    // `useTauriEvent` awaits the subscription, as Tauri's own `listen` returns a promise.
    return Promise.resolve(() => {});
  });
  onSidecarRestarted.mockReset().mockImplementation((h: typeof fireRestarted) => {
    fireRestarted = h;
    return Promise.resolve(() => {});
  });
  onSidecarBehind.mockReset().mockImplementation((h: typeof fireBehind) => {
    fireBehind = h;
    return () => {};
  });
});

const mounted = (
  onLost = vi.fn(),
  onReplaced = vi.fn(),
  expectedStop: { current: boolean } = { current: false },
) => ({
  ...renderHook(() => useRuntimeHealth(onLost, onReplaced, expectedStop)),
  onLost,
  onReplaced,
});

describe('whether the runtime is there', () => {
  it('says nothing is wrong to begin with', () => {
    const { result } = mounted();

    expect(result.current.stopped).toBeNull();
    expect(result.current.behind).toBeNull();
  });

  it('says so when the sidecar goes, in its own words', async () => {
    const { result } = mounted();

    act(() => fireStopped('the sidecar stopped and will not be replaced'));

    expect(result.current.stopped).toBe('the sidecar stopped and will not be replaced');
  });

  // Whatever was waiting on it will never be answered, and shows as the app doing nothing.
  it('stands down what was waiting on it', () => {
    const t = mounted();

    act(() => fireStopped('gone'));

    expect(t.onLost).toHaveBeenCalled();
  });

  it('stands down without showing an error when installer exit expects the sidecar to stop', () => {
    const expectedStop = { current: true };
    const t = mounted(vi.fn(), vi.fn(), expectedStop);

    act(() => fireStopped('the sidecar stopped and will not be replaced'));

    expect(t.result.current.stopped).toBeNull();
    expect(t.onLost).toHaveBeenCalledOnce();
  });

  it('still reports a later unexpected stop through the same subscription', () => {
    const expectedStop = { current: true };
    const t = mounted(vi.fn(), vi.fn(), expectedStop);
    act(() => fireStopped('expected'));
    expectedStop.current = false;

    act(() => fireStopped('unexpected'));

    expect(t.result.current.stopped).toBe('unexpected');
    expect(t.onLost).toHaveBeenCalledTimes(2);
  });

  it('clears the message when a replacement is up', () => {
    const { result } = mounted();
    act(() => fireStopped('gone'));

    act(() => fireRestarted());

    expect(result.current.stopped).toBeNull();
  });

  it('tells the caller a replacement knows nothing', () => {
    const t = mounted();

    act(() => fireRestarted());

    expect(t.onReplaced).toHaveBeenCalled();
  });
});

describe('whether it is the runtime this window expects', () => {
  it('asks at once', async () => {
    mounted();

    await waitFor(() => expect(staleRuntime).toHaveBeenCalled());
  });

  it('refuses one built from a different protocol', async () => {
    staleRuntime.mockResolvedValue('built from a different version');
    const { result } = mounted();

    await waitFor(() => expect(result.current.stopped).toBe('built from a different version'));
  });

  it('says nothing about one that matches', async () => {
    const { result } = mounted();

    await waitFor(() => expect(staleRuntime).toHaveBeenCalled());
    expect(result.current.stopped).toBeNull();
  });

  // A replacement is a different process, and on a dev machine often a different build.
  it('asks again about a replacement', async () => {
    mounted();
    await waitFor(() => expect(staleRuntime).toHaveBeenCalledTimes(1));

    act(() => fireRestarted());

    await waitFor(() => expect(staleRuntime).toHaveBeenCalledTimes(2));
  });
});

describe('whether it is a version behind the source', () => {
  it('passes on what the dev server said', () => {
    const { result } = mounted();

    act(() => fireBehind('git.ts changed after the runtime started'));

    expect(result.current.behind).toBe('git.ts changed after the runtime started');
  });

  it('can be put away', () => {
    const { result } = mounted();
    act(() => fireBehind('changed'));

    act(() => result.current.dismiss());

    expect(result.current.behind).toBeNull();
  });

  it('goes away by itself once a replacement is up', () => {
    const { result } = mounted();
    act(() => fireBehind('changed'));

    act(() => fireRestarted());

    expect(result.current.behind).toBeNull();
  });

  it('rebuilds and then replaces, in that order', async () => {
    const order: string[] = [];
    rebuildSidecar.mockImplementation(() => {
      order.push('rebuild');
      return Promise.resolve();
    });
    restartRuntime.mockImplementation(() => {
      order.push('restart');
      return Promise.resolve();
    });
    const { result } = mounted();

    await act(async () => result.current.rebuild());

    expect(order).toEqual(['rebuild', 'restart']);
  });

  it('will not start a second rebuild while one is running', async () => {
    let finish: () => void = () => {};
    rebuildSidecar.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const { result } = mounted();

    act(() => result.current.rebuild());

    await waitFor(() => expect(result.current.rebuilding).toBe(true));
    await act(async () => finish());
    expect(result.current.rebuilding).toBe(false);
  });

  /**
   * A rebuild that failed and one that worked must not look the same: restarting after one
   * that did not happen loads the old code and says the problem is dealt with.
   */
  it('keeps the notice up when the rebuild fails, and says why', async () => {
    rebuildSidecar.mockRejectedValue(new Error('TS2339: Property does not exist'));
    const { result } = mounted();
    act(() => fireBehind('changed'));

    await act(async () => result.current.rebuild());

    expect(result.current.behind).toMatch(/TS2339/);
  });

  it('does not replace the runtime when the rebuild failed', async () => {
    rebuildSidecar.mockRejectedValue(new Error('nope'));
    const { result } = mounted();

    await act(async () => result.current.rebuild());

    expect(restartRuntime).not.toHaveBeenCalled();
  });

  it('stops rebuilding once it has finished failing', async () => {
    rebuildSidecar.mockRejectedValue(new Error('nope'));
    const { result } = mounted();

    await act(async () => result.current.rebuild());

    expect(result.current.rebuilding).toBe(false);
  });
});
