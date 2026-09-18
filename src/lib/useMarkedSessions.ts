import { useCallback, useEffect, useState } from 'react';

import { goneFrom, needsPruning } from './pruneSessions';

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

/** Drop marks for sessions that no longer exist. */
async function prune(key: string): Promise<void> {
  const gone = await goneFrom(read(key));
  if (!gone) return;

  // Reread rather than filtering the copy asked about: something may have been marked while
  // the sidecar was answering, and dropping only what is known gone keeps it.
  localStorage.setItem(key, JSON.stringify(read(key).filter((id) => !gone.has(id))));
}

export function useMarkedSessions(key: string) {
  const [ids, setIds] = useState<string[]>(() => read(key));

  useEffect(() => {
    if (!needsPruning(key)) return;
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
