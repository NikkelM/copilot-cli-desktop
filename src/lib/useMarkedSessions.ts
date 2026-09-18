import { useCallback, useEffect, useState } from 'react';

import { existingSessions } from './sidecar';

/**
 * A set of sessions this app has marked, remembered across restarts.
 *
 * Two of these exist: the ones kept within reach, and the ones put away. They are different
 * decisions about the same thing and share everything about how they are kept, including the
 * part that is easy to get subtly wrong - pruning marks for sessions that are gone without
 * throwing away one made while the sidecar was answering.
 *
 * Kept by this app rather than in the CLI's store, which is read-only here, and keyed by
 * session id so a mark means the same thing whatever the session is called later.
 */

/** The ids marked, in no particular order: the sidebar orders by activity, not by this. */
function read(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Drop marks for sessions that no longer exist.
 *
 * Nothing else removes an entry, so without this the list grows for the life of the install
 * and keeps state about sessions that are gone - the same reason the review marks are
 * pruned (#152), and the same test: what is on disk, rather than what the sidebar happens
 * to be showing. A session can be missing from the list for reasons that have nothing to do
 * with deletion, and throwing away a deliberate mark over that would be worse than keeping
 * a stale one.
 */
async function prune(key: string): Promise<void> {
  const ids = read(key);
  if (ids.length === 0) return;

  const alive = new Set(await existingSessions(ids));
  if (alive.size === ids.length) return;

  // Reread rather than filtering the copy above: something may have been marked while the
  // sidecar was answering, and that entry is newer than anything here.
  const kept = read(key).filter((id) => alive.has(id) || !ids.includes(id));
  localStorage.setItem(key, JSON.stringify(kept));
}

/** Which sets have been pruned. Each answers about the whole install, so once each is enough. */
const pruned = new Set<string>();

export function useMarkedSessions(key: string) {
  const [ids, setIds] = useState<string[]>(() => read(key));

  useEffect(() => {
    if (pruned.has(key)) return;
    pruned.add(key);
    void prune(key).then(() => setIds(read(key)));
  }, [key]);

  const toggle = useCallback(
    (sessionId: string) => {
      setIds((current) => {
        const next = current.includes(sessionId)
          ? current.filter((id) => id !== sessionId)
          : [...current, sessionId];
        localStorage.setItem(key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );

  return { ids, toggle };
}
