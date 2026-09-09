// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useTauriEvent } from './useTauriEvent';

/**
 * A subscription whose registration can be resolved on demand.
 *
 * The whole point of this hook is the window between calling subscribe and its promise
 * resolving, so every test here needs to unmount inside that window rather than after it.
 */
function deferred() {
  const unlisten = vi.fn();
  let resolve!: (off: () => void) => void;
  const subscribe = vi.fn(() => new Promise<() => void>((r) => (resolve = r)));
  return { subscribe, unlisten, register: () => resolve(unlisten) };
}

describe('subscribing for the lifetime of a component', () => {
  it('subscribes once on mount', () => {
    const { subscribe } = deferred();
    renderHook(() => useTauriEvent(subscribe));

    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', async () => {
    const { subscribe, unlisten, register } = deferred();
    const { unmount } = renderHook(() => useTauriEvent(subscribe));

    register();
    await Promise.resolve();
    expect(unlisten).not.toHaveBeenCalled();

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  // The reason the hook exists. StrictMode and Fast Refresh both tear an effect down
  // before an in-flight registration resolves, and every listener left behind makes the
  // next event handled one extra time.
  it('unsubscribes a registration that lands after the unmount', async () => {
    const { subscribe, unlisten, register } = deferred();
    const { unmount } = renderHook(() => useTauriEvent(subscribe));

    unmount();
    expect(unlisten).not.toHaveBeenCalled();

    register();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing behind when mounted and unmounted repeatedly mid-registration', async () => {
    const pending: Array<() => void> = [];
    const unlisten = vi.fn();
    const subscribe = vi.fn(() => new Promise<() => void>((r) => pending.push(() => r(unlisten))));

    for (let i = 0; i < 5; i++) renderHook(() => useTauriEvent(subscribe)).unmount();
    pending.forEach((register) => register());
    await Promise.resolve();

    expect(subscribe).toHaveBeenCalledTimes(5);
    expect(unlisten).toHaveBeenCalledTimes(5);
  });

  it('does not resubscribe on a re-render', () => {
    const { subscribe } = deferred();
    const { rerender } = renderHook(() => useTauriEvent(subscribe));

    rerender();
    rerender();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('resubscribes when a dependency changes, and drops the old listener first', async () => {
    const first = deferred();
    const second = deferred();
    const { rerender } = renderHook(
      ({ id }: { id: number }) => useTauriEvent(id === 1 ? first.subscribe : second.subscribe, [id]),
      { initialProps: { id: 1 } },
    );

    first.register();
    await Promise.resolve();

    rerender({ id: 2 });
    expect(first.unlisten).toHaveBeenCalledTimes(1);
    expect(second.subscribe).toHaveBeenCalledTimes(1);
  });

  it('stays subscribed while the dependency holds', async () => {
    const { subscribe, unlisten, register } = deferred();
    const { rerender } = renderHook(({ id }: { id: number }) => useTauriEvent(subscribe, [id]), {
      initialProps: { id: 1 },
    });

    register();
    await Promise.resolve();
    rerender({ id: 1 });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unlisten).not.toHaveBeenCalled();
  });

  // Nothing registered means nothing to unregister, and the cleanup runs regardless.
  it('unmounts cleanly when registration never resolves', () => {
    const { subscribe, unlisten } = deferred();
    const { unmount } = renderHook(() => useTauriEvent(subscribe));

    expect(() => unmount()).not.toThrow();
    expect(unlisten).not.toHaveBeenCalled();
  });
});
