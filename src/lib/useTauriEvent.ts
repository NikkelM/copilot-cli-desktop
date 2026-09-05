import { useEffect } from 'react';

/** Tauri's listen() resolves to its own unlisten function. */
type Subscribe = () => Promise<() => void>;

/**
 * Subscribe to a Tauri event for the lifetime of the component.
 *
 * Registration is asynchronous, so a naive `return () => { void p.then(off => off()) }`
 * can leak a listener when the effect is torn down before registration resolves.
 * React StrictMode and Fast Refresh both do exactly that, and every leaked listener
 * makes each event handled an extra time.
 */
export function useTauriEvent(subscribe: Subscribe, deps: unknown[] = []): void {
  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;

    void subscribe().then((unlisten) => {
      // The effect was already cleaned up while registration was in flight.
      if (cancelled) unlisten();
      else off = unlisten;
    });

    return () => {
      cancelled = true;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
