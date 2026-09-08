import { useCallback, useEffect, useState } from 'react';

import type { FileDiff, SessionChange } from '../../shared/protocol';
import { getChanges, getDiff } from './sidecar';

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

  const since = showAll ? undefined : (reviewedAt ?? undefined);

  // Another session changed other files. Holding the last one's would say something false.
  useEffect(() => {
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
      setDiffs({});
      getChanges(sessionId, from)
        .then((result) => setChanges(result.changes))
        .catch((error: unknown) => setFailed(String(error)))
        .finally(() => setLoading(false));
    },
    [sessionId],
  );

  const load = useCallback(() => read(since), [read, since]);

  const diff = useCallback(
    (path: string) => {
      if (!sessionId || diffs[path]) return;

      getDiff(sessionId, path, since)
        .then((result) => setDiffs((current) => ({ ...current, [path]: result })))
        .catch((error: unknown) => setFailed(String(error)));
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
