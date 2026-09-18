import { useEffect } from 'react';

import { useHotGeneration } from './hotGeneration';

/** Tauri's listen() resolves to its own unlisten function. */
type Subscribe = () => Promise<() => void>;

// Re-exported because this is where the tests that cover a hot update already look for it.
export { moduleReplaced } from './hotGeneration';

/**
 * Subscribe to a Tauri event for the lifetime of the component.
 *
 * Registration is asynchronous, so a naive `return () => { void p.then(off => off()) }`
 * can leak a listener when the effect is torn down before registration resolves.
 * React StrictMode and Fast Refresh both do exactly that, and every leaked listener
 * makes each event handled an extra time.
 *
 * Re-registered after every hot update, so the handler running is the one that was just
 * edited rather than the one from before it (#181).
 */
export function useTauriEvent(subscribe: Subscribe, deps: unknown[] = []): void {
  const hot = useHotGeneration();

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
  }, [...deps, hot]);
}
