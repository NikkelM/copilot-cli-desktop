import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionSummary, TranscriptEvent } from '../../shared/protocol';
import { orderSessions } from './ordering';
import { listSessions, runtimeStatus } from './sidecar';

/**
 * Which sessions exist, in the order the sidebar shows them.
 *
 * The list has two sources, and they differ in when rather than in what. Fetching gives
 * every session on disk, including ones this app has never opened, and since #164 its
 * previews come from the event logs and are right. What is slow is the asking: a refetch
 * happens when the history database changes, debounced by a second and a half, and the
 * logs themselves are not watched at all.
 *
 * Live events arrive as they happen, but only for sessions this app holds open. So the
 * fetch is the list and the events are what keeps the sessions in front of the reader from
 * visibly trailing their own transcripts. The overlay has to outlive a single fetch because
 * a refetch can land between a reply and the write that would have carried it.
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
  /** Sessions with a turn running, whichever one is on screen. */
  const [working, setWorking] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Sessions taken out of the list before disk agrees.
   *
   * Deleting is the slow kind of disk work - a large session is a gigabyte of event log and
   * thousands of snapshot blobs - and waiting for it before redrawing left a row someone had
   * just confirmed the deletion of sitting there, for longer the larger the session was.
   */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());

  const refresh = useCallback(() => {
    // Returned so a caller that needs the list to contain something can wait for it.
    return listSessions()
      // A fetch that lands between a reply and the write that announces it would otherwise
      // show the session a turn behind, so what the app has already heard wins.
      .then((result) => {
        setSessions(result.sessions);
        // A session the fetch no longer knows about is gone for real, so the note saying to
        // hide it has nothing left to hide and would otherwise be kept for the app's life.
        setDropped((current) => {
          if (current.size === 0) return current;
          const listed = new Set(result.sessions.map((session) => session.sessionId));
          const next = new Set([...current].filter((id) => listed.has(id)));
          return next.size === current.size ? current : next;
        });
      })
      .catch((e: unknown) => onError(String(e)));
  }, [onError]);

  /** Take a session out of the list now, without waiting to be told it has gone. */
  const drop = useCallback((sessionId: string) => {
    setDropped((current) => (current.has(sessionId) ? current : new Set(current).add(sessionId)));
  }, []);

  /** Put one back, for when whatever was going to remove it did not. */
  const restore = useCallback((sessionId: string) => {
    setDropped((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

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
   * The sidebar is only refetched when the history database changes, and a reply reaches
   * this app long before that. Its events are already streaming, so use them rather than
   * wait to be told. This applies to every loaded session, not just the one on screen.
   */
  const observe = useCallback((sessionId: string, event: TranscriptEvent) => {
    // Which sessions have a turn running, for the sidebar to say so (#115). Tracked here
    // rather than in the app because this is the one place that sees every session's
    // events; the app's own `busy` covers only the session on screen.
    if (event.type === 'assistant.turn_start') {
      setWorking((current) => (current.has(sessionId) ? current : new Set(current).add(sessionId)));
    }
    // Not `assistant.turn_end`, which is one model round trip: a request that calls tools
    // ends and starts a turn many times over, and the gaps are not idleness.
    if (event.type === 'session.idle' || event.type === 'abort') {
      setWorking((current) => {
        if (!current.has(sessionId)) return current;
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
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

    // A session let go cannot still be mid-turn, and it will send no idle event to say so.
    if (!loaded) {
      setWorking((current) => {
        if (!current.has(sessionId)) return current;
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }, []);

  const all = useMemo(
    () => orderSessions(sessions, activeOrder).filter((session) => !dropped.has(session.sessionId)),
    [sessions, activeOrder, dropped],
  );

  const find = useCallback(
    (sessionId: string | null) => all.find((session) => session.sessionId === sessionId) ?? null,
    [all],
  );

  return { all, find, maxLoaded, working, refresh, drop, restore, observe, observeLoaded };
}

