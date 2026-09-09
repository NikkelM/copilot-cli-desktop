import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileDiff, SessionChange } from '../../shared/protocol';
import { existingSessions, getChanges, getDiff } from './sidecar';

/** Where each session's review mark is kept, by session id. */
const REVIEWED = 'copilot-desktop.reviewed';

/**
 * How far each session has been reviewed.
 *
 * A snapshot timestamp rather than a wall clock reading of when the button was pressed:
 * the mark then means "I have seen up to this turn", which stays true whatever the two
 * clocks disagree about and whatever arrives while the panel is open.
 */
function readMarks(): Record<string, string> {
  try {
    const stored = localStorage.getItem(REVIEWED);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Drop marks for sessions that no longer exist.
 *
 * Nothing else removes an entry, so without this the map grows for the life of the install
 * and keeps state about sessions that are gone (#152). Deleting a session from the app is
 * not built yet (#63), and a session can also be deleted from the CLI or by hand, so the
 * check is against what is on disk rather than against a deletion we performed.
 *
 * Absence from the sidebar is deliberately not the test: a session can be missing from the
 * list for reasons that have nothing to do with deletion, and acting on that would throw
 * away the mark of a session that is still there.
 */
async function pruneMarks(): Promise<void> {
  const marks = readMarks();
  const ids = Object.keys(marks);
  if (ids.length === 0) return;

  const alive = new Set(await existingSessions(ids));
  if (alive.size === ids.length) return;

  // Reread rather than filtering the copy above: the reader may have marked something as
  // seen while the sidecar was answering, and that entry is newer than anything here.
  const current = readMarks();
  const kept = Object.fromEntries(Object.entries(current).filter(([id]) => alive.has(id) || !(id in marks)));
  localStorage.setItem(REVIEWED, JSON.stringify(kept));
}

/** Whether the prune has already run. It answers about the whole install, so once is enough. */
let pruned = false;

/**
 * What a session changed, asked for only when someone wants to know.
 *
 * Reading it costs no Copilot process, but it does cost reading every file the session
 * touched at both ends - around half a second for a long session - so it waits to be asked
 * rather than happening on every selection. Diffs are fetched one file at a time for the
 * same reason: the whole set of them is tens of megabytes, and almost none of it is looked
 * at.
 *
 * Once a session has been reviewed the default question becomes "and what since then",
 * which is the one worth asking on a session that has been going for days. The whole
 * history stays available, but it is no longer the starting point.
 */
export function useChanges(sessionId: string | null) {
  const [changes, setChanges] = useState<SessionChange[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({});
  const [reviewedAt, setReviewedAt] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  /**
   * Which reading of the list the diffs on hand belong to.
   *
   * A diff already on its way when the list is reread answers the old span, so its reply
   * has to be dropped rather than filed against the new one.
   */
  const asked = useRef(0);
  /** Paths already on their way, so an open row cannot ask twice for the same answer. */
  const asking = useRef(new Set<string>());

  const since = showAll ? undefined : (reviewedAt ?? undefined);

  useEffect(() => {
    if (pruned) return;
    pruned = true;
    // A failed prune leaves the map as it was, which is what it was anyway. Next launch retries.
    void pruneMarks().catch(() => {});
  }, []);

  // Another session changed other files. Holding the last one's would say something false.
  useEffect(() => {
    // Anything still in flight answers about the session being left, so it is disowned
    // here as well as in `read`: the panel need not have asked again for a late reply to
    // arrive and file one session's files under another's name.
    asked.current += 1;
    asking.current.clear();
    setChanges(null);
    setDiffs({});
    setFailed(null);
    setShowAll(false);
    setReviewedAt(sessionId ? (readMarks()[sessionId] ?? null) : null);
  }, [sessionId]);

  const read = useCallback(
    (from: string | undefined) => {
      if (!sessionId) return;

      setLoading(true);
      setFailed(null);
      // Diffs on hand answer the old span, so they cannot be shown against the new one.
      asked.current += 1;
      const span = asked.current;
      asking.current.clear();
      setDiffs({});
      getChanges(sessionId, from)
        .then((result) => span === asked.current && setChanges(result.changes))
        .catch((error: unknown) => span === asked.current && setFailed(String(error)))
        .finally(() => {
          if (span === asked.current) setLoading(false);
        });
    },
    [sessionId],
  );

  const load = useCallback(() => read(since), [read, since]);

  const diff = useCallback(
    (path: string) => {
      if (!sessionId || diffs[path] || asking.current.has(path)) return;

      const span = asked.current;
      asking.current.add(path);
      getDiff(sessionId, path, since)
        .then((result) => {
          if (span !== asked.current) return;
          setDiffs((current) => ({ ...current, [path]: result }));
        })
        .catch((error: unknown) => span === asked.current && setFailed(String(error)))
        .finally(() => asking.current.delete(path));
    },
    [sessionId, diffs, since],
  );

  /**
   * Mark everything currently listed as seen.
   *
   * The mark is the newest turn on show rather than the current time, so a turn that lands
   * while the panel is open is not silently marked as reviewed along with it.
   */
  const review = useCallback(() => {
    if (!sessionId || !changes?.length) return;

    const newest = changes.reduce((latest, change) => (change.changedAt > latest ? change.changedAt : latest), '');
    if (!newest) return;

    localStorage.setItem(REVIEWED, JSON.stringify({ ...readMarks(), [sessionId]: newest }));
    setReviewedAt(newest);
    setShowAll(false);
    read(newest);
  }, [sessionId, changes, read]);

  /** Switch between the whole session and only what is new since the mark. */
  const setSpan = useCallback(
    (all: boolean) => {
      setShowAll(all);
      read(all ? undefined : (reviewedAt ?? undefined));
    },
    [read, reviewedAt],
  );

  return { changes, loading, failed, diffs, load, diff, review, reviewedAt, showAll, setSpan };
}
