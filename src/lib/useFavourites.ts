import { useCallback, useEffect, useState } from 'react';

import { existingSessions } from './sidecar';

/** Where the choice lives. The CLI owns its own store and this app only ever reads it. */
const FAVOURITES = 'copilot-desktop.favourites';

/** The ids marked, in no particular order: the sidebar orders by activity, not by this. */
function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FAVOURITES) ?? '[]');
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
async function prune(): Promise<void> {
  const ids = read();
  if (ids.length === 0) return;

  const alive = new Set(await existingSessions(ids));
  if (alive.size === ids.length) return;

  // Reread rather than filtering the copy above: something may have been marked while the
  // sidecar was answering, and that entry is newer than anything here.
  const kept = read().filter((id) => alive.has(id) || !ids.includes(id));
  localStorage.setItem(FAVOURITES, JSON.stringify(kept));
}

/** Whether the prune has run. It answers about the whole install, so once is enough. */
let pruned = false;

/**
 * The sessions someone has marked to keep within reach.
 *
 * Kept by this app rather than in the CLI's store, which is read-only here, and keyed by
 * session id so it means the same thing whatever the session is called later.
 */
export function useFavourites() {
  const [ids, setIds] = useState<string[]>(read);

  useEffect(() => {
    if (pruned) return;
    pruned = true;
    void prune().then(() => setIds(read()));
  }, []);

  const toggle = useCallback((sessionId: string) => {
    setIds((current) => {
      const next = current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId];
      localStorage.setItem(FAVOURITES, JSON.stringify(next));
      return next;
    });
  }, []);

  return { favourites: ids, toggle };
}
