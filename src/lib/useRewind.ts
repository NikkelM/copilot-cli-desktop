import { useCallback, useEffect, useRef, useState } from 'react';

import type { RewindPoint, RewindPreview, RewindResult, RewindUnavailable } from '../../shared/protocol';
import { getRewindPoints, previewRewind, rewindSession } from './sidecar';
import { explain } from './errors';

/**
 * The turns a session can be put back to, and putting it back (#156).
 *
 * Asked for rather than kept up to date: the runtime answers this from the live session, so
 * reading it resumes one. That is the opposite of what this app is for, and a list nobody
 * has opened is not worth a Copilot process - so nothing is asked until somebody looks.
 *
 * The points are keyed by the id of the user message that begins what would be discarded,
 * which is the same id the transcript already keys that row by. So the two need no mapping
 * between them: a row is rewindable if its key is in here.
 */
export function useRewind(sessionId: string | null) {
  const [points, setPoints] = useState<Map<string, RewindPoint>>(new Map());
  const [unavailable, setUnavailable] = useState<RewindUnavailable | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** Which session the answer on its way belongs to, so a late one cannot land on another. */
  const asked = useRef(0);

  useEffect(() => {
    asked.current += 1;
    setPoints(new Map());
    setUnavailable(null);
    setFailed(null);
    setLoading(false);
  }, [sessionId]);

  const load = useCallback(() => {
    if (!sessionId) return;

    asked.current += 1;
    const mine = asked.current;
    setLoading(true);
    setFailed(null);

    getRewindPoints(sessionId)
      .then((result) => {
        if (mine !== asked.current) return;
        setPoints(new Map(result.points.map((point) => [point.eventId, point])));
        setUnavailable(result.unavailable ?? null);
      })
      .catch((error: unknown) => mine === asked.current && setFailed(explain(error)))
      .finally(() => {
        if (mine === asked.current) setLoading(false);
      });
  }, [sessionId]);

  const preview = useCallback(
    (eventId: string): Promise<RewindPreview> => {
      if (!sessionId) return Promise.reject(new Error('No session'));
      return previewRewind(sessionId, eventId);
    },
    [sessionId],
  );

  /**
   * Put the session back, and forget the points.
   *
   * Forgotten rather than reread: the turns that were discarded are gone, so every point
   * from the one rewound to onwards has stopped existing. Keeping them would offer a way
   * back to a turn that is no longer there.
   */
  const rewind = useCallback(
    async (eventId: string, files: boolean): Promise<RewindResult> => {
      if (!sessionId) throw new Error('No session');

      const result = await rewindSession(sessionId, eventId, files);
      // Only when it actually happened. A rewind refused because the session was busy has
      // changed nothing, and the points it was offering are all still good.
      if (result.outcome !== 'busy' && result.outcome !== 'untracked' && result.outcome !== 'remote') {
        asked.current += 1;
        setPoints(new Map());
      }
      return result;
    },
    [sessionId],
  );

  return { points, unavailable, loading, failed, load, preview, rewind };
}
