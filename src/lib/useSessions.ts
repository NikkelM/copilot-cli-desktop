import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionSummary, TranscriptEvent } from '../../shared/protocol';
import { toPreview } from '../../shared/preview';
import { mergeLivePreviews } from './livePreviews';
import { orderSessions } from './ordering';
import { listSessions, runtimeStatus } from './sidecar';
import { contentOf } from './timeline';

/**
 * Which sessions exist, in the order the sidebar shows them.
 *
 * The list has two sources that disagree. Fetching gives every session on disk, including
 * ones this app has never opened, but its previews come from a table the runtime flushes
 * well after the fact. Live events are immediate but only cover sessions this app holds
 * open. So the fetch is the list and the events are the correction, and the correction has
 * to outlive any single fetch: the store changes on every turn of every running session,
 * which means a refetch can land at any moment and would otherwise put the stale preview
 * straight back.
 *
 * The caller owns the event subscriptions and hands the two kinds here, rather than this
 * subscribing for itself. One `session.event` stream feeds six different parts of the app,
 * and splitting it would mean several listeners racing to interpret the same event.
 */
export function useSessions(onError: (message: string) => void) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** Session ids in activation order, most recent first. Fixes the active group's order. */
  const [activeOrder, setActiveOrder] = useState<string[]>([]);
  const [maxLoaded, setMaxLoaded] = useState<number | undefined>(undefined);

  /**
   * Previews derived from live events, which are ahead of the database.
   * A ref rather than state: refetches read it, but it never needs to trigger a render
   * on its own, since the render always follows a setSessions in the same handler.
   */
  const livePreviews = useRef(new Map<string, string | null>());

  const refresh = useCallback(() => {
    // Returned so a caller that needs the list to contain something can wait for it.
    return listSessions()
      // The fetched previews come from the lagging turns table, so anything already
      // learned from live events wins until the database catches up.
      .then((result) => setSessions(mergeLivePreviews(result.sessions, livePreviews.current)))
      .catch((e: unknown) => onError(String(e)));
  }, [onError]);

  useEffect(() => void refresh(), [refresh]);

  // How many sessions may be resident at once, so the sidebar can say what the cap is.
  // Asked once: it is a setting rather than a reading, and asking costs no process.
  useEffect(() => {
    runtimeStatus()
      .then((status) => setMaxLoaded(status.maxLoadedSessions))
      .catch(() => undefined);
  }, []);

  /**
   * Take what a session's own events say about it.
   *
   * The sidebar preview comes from the turns table, which is flushed well after the fact,
   * so a loaded session would keep showing an older reply. Its events are already
   * streaming, so use them and skip the wait entirely. This applies to every loaded
   * session, not just the one on screen.
   */
  const observe = useCallback((sessionId: string, event: TranscriptEvent) => {
    const spoken = event.type === 'assistant.message' ? contentOf(event) : null;
    if (!spoken) return;

    const preview = toPreview(spoken);
    livePreviews.current.set(sessionId, preview);

    setSessions((current) =>
      current.map((session) => (session.sessionId === sessionId ? { ...session, preview } : session)),
    );
  }, []);

  /** Take a session waking or being let go, which moves it between the sidebar's groups. */
  const observeLoaded = useCallback((sessionId: string, loaded: boolean) => {
    setSessions((current) =>
      current.map((session) => (session.sessionId === sessionId ? { ...session, loaded } : session)),
    );

    // A session entering the active group goes to its top; leaving drops it entirely.
    // Sessions already active keep their position, so the list does not shuffle when
    // messages are sent.
    setActiveOrder((current) =>
      loaded
        ? current.includes(sessionId)
          ? current
          : [sessionId, ...current]
        : current.filter((id) => id !== sessionId),
    );

    // Once unloaded the app no longer sees this session's events, so its own preview
    // must stop overriding whatever the database reports.
    if (!loaded) livePreviews.current.delete(sessionId);
  }, []);

  const all = useMemo(() => orderSessions(sessions, activeOrder), [sessions, activeOrder]);

  const find = useCallback(
    (sessionId: string | null) => all.find((session) => session.sessionId === sessionId) ?? null,
    [all],
  );

  return { all, find, maxLoaded, refresh, observe, observeLoaded };
}
