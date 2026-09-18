import { useSyncExternalStore } from 'react';

/**
 * How many times the running app has been replaced under itself, which outside development
 * is never.
 *
 * Registering a listener with fixed deps is right - the subscription does not depend on
 * anything that changes - but it means Fast Refresh replaces the module, re-renders the
 * component, and leaves the effect alone. The listener still handling events is then the
 * one from before the edit, and since everything else on screen did update, the feature
 * looks broken rather than stale. Three separate searches started in the wrong place
 * because of it (#181), and a fourth did when `useShortcuts` grew a wheel listener that
 * appeared to do nothing until the app was restarted.
 *
 * Counting hot updates and registering against the count fixes that at its source: any
 * update, in any module, re-registers every subscription with the closure that exists now.
 * It costs one registration per edit, and nothing at all in a built app, where
 * `import.meta.hot` is undefined and the count stays at zero forever.
 *
 * Its own module rather than a corner of the event hook, because a second hook needs it -
 * which is the point at which something shared stops being one hook's business.
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
 * A value that changes whenever the app has been hot-replaced.
 *
 * Put in an effect's dependencies, it makes that effect run again after every edit, and
 * never in a built app.
 */
export function useHotGeneration(): number {
  return useSyncExternalStore(watchGeneration, readGeneration, readGeneration);
}
