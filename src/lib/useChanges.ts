import { useCallback, useEffect, useState } from 'react';

import type { FileDiff, SessionChange } from '../../shared/protocol';
import { getChanges, getDiff } from './sidecar';

/**
 * What a session changed, asked for only when someone wants to know.
 *
 * Reading it costs no Copilot process, but it does cost reading every file the session
 * touched at both ends - around half a second for a long session - so it waits to be asked
 * rather than happening on every selection. Diffs are fetched one file at a time for the
 * same reason: the whole set of them is tens of megabytes, and almost none of it is looked
 * at.
 */
export function useChanges(sessionId: string | null) {
  const [changes, setChanges] = useState<SessionChange[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({});

  // Another session changed other files. Holding the last one's would say something false.
  useEffect(() => {
    setChanges(null);
    setDiffs({});
    setFailed(null);
  }, [sessionId]);

  const load = useCallback(() => {
    if (!sessionId) return;

    setLoading(true);
    setFailed(null);
    getChanges(sessionId)
      .then((result) => setChanges(result.changes))
      .catch((error: unknown) => setFailed(String(error)))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const diff = useCallback(
    (path: string) => {
      if (!sessionId || diffs[path]) return;

      getDiff(sessionId, path)
        .then((result) => setDiffs((current) => ({ ...current, [path]: result })))
        .catch((error: unknown) => setFailed(String(error)));
    },
    [sessionId, diffs],
  );

  return { changes, loading, failed, diffs, load, diff };
}
