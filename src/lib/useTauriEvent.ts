import { useEffect, useSyncExternalStore } from 'react';

/** Tauri's listen() resolves to its own unlisten function. */
type Subscribe = () => Promise<() => void>;

/**
 * How many times the running app has been replaced under itself, which outside development
 * is never.
 *
 * Registering with fixed deps is right - see the hook below - but it means Fast Refresh
 * replaces the module, re-renders the component, and leaves the effect alone. The listener
 * still handling events is then the one from before the edit, and since everything else on
 * screen did update, the feature looks broken rather than stale. Three separate searches
 * started in the wrong place because of it (#181).
 *
 * Counting hot updates and registering against the count fixes that at its source: any
 * update, in any module, re-registers every subscription with the closure that exists now.
 * It costs one registration per edit, and nothing at all in a built app, where
 * import.meta.hot is undefined and the count stays at zero forever.
 */
let generation = 0;
const watchers = new Set<() => void>();

/** Count a replacement and re-register everything, standing in for a hot update in tests. */
export function moduleReplaced(): void {
  generation += 1;
  for (const notify of watchers) notify();
}

function watchGeneration(notify: () => void): () => void {
  watchers.add(notify);
  return () => {
    watchers.delete(notify);
  };
}

function readGeneration(): number {
  return generation;
}

// Fires once an update has been applied, so the closures read afterwards are the new ones.
if (import.meta.hot) import.meta.hot.on('vite:afterUpdate', moduleReplaced);

/**
 * Subscribe to a Tauri event for the lifetime of the component.
 *
 * Registration is asynchronous, so a naive `return () => { void p.then(off => off()) }`
 * can leak a listener when the effect is torn down before registration resolves.
 * React StrictMode and Fast Refresh both do exactly that, and every leaked listener
 * makes each event handled an extra time.
 */
export function useTauriEvent(subscribe: Subscribe, deps: unknown[] = []): void {
  const hot = useSyncExternalStore(watchGeneration, readGeneration, readGeneration);

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
