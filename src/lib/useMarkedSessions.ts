import { useCallback, useEffect, useState } from 'react';

import { goneFrom, needsPruning } from './pruneSessions';
import { read as readStore, save } from './store';

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
    const parsed: unknown = JSON.parse(readStore('sessions', key) ?? '[]');
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
  save('sessions', key, JSON.stringify(read(key).filter((id) => !gone.has(id))));
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
        save('sessions', key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );

  /** Take marks off, ignoring any that were never on, so calling it twice costs nothing. */
  const drop = useCallback(
    (sessionIds: readonly string[]) => {
      setIds((current) => {
        const going = new Set(sessionIds);
        if (!current.some((id) => going.has(id))) return current;

        const next = current.filter((id) => !going.has(id));
        save('sessions', key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );

  const reorder = useCallback((sessionId: string, targetId: string, after = false, visibleOrder?: readonly string[]) => {
    setIds((current) => {
      if (sessionId === targetId || !current.includes(sessionId) || !current.includes(targetId)) return current;
      const visible = visibleOrder?.filter((id) => current.includes(id));
      let at = 0;
      const ordered = visible ? current.map((id) => visible.includes(id) ? visible[at++]! : id) : current;
      const next = ordered.filter((id) => id !== sessionId);
      next.splice(next.indexOf(targetId) + (after ? 1 : 0), 0, sessionId);
      save('sessions', key, JSON.stringify(next));
      return next;
    });
  }, [key]);

  return { ids, toggle, drop, reorder };
}
