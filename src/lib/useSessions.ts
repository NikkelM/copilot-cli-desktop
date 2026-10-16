import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionSummary, TranscriptEvent } from '../../shared/protocol';
import { orderSessions } from './ordering';
import { listSessions, runtimeStatus } from './sidecar';
import { read, save } from './store';

const ACTIVE_ORDER = 'activeSessionOrder';
const ACTIVE_SEEN = 'activeSessionLastLoaded';
const ORDER_RETENTION = 7 * 24 * 60 * 60 * 1000;

function rememberedLastLoaded(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(read('sessions', ACTIVE_SEEN) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, time]) => typeof time === 'number' && Number.isFinite(time)));
  } catch (error) {
    console.error('Could not read active session last-loaded times', error);
    return {};
  }
}

function rememberedOrder(): string[] {
  const stored = read('sessions', ACTIVE_ORDER);
  if (!stored) return [];
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];
  } catch (error) {
    console.error('Could not read active session order', error);
    return [];
  }
}

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
  /** Activation order until manually arranged, then remembered slots across unloads */
  const [activeOrder, setActiveOrder] = useState<string[]>(rememberedOrder);
  const manualOrder = useRef(read('sessions', ACTIVE_ORDER) !== null);
  const [initialLastLoaded] = useState(rememberedLastLoaded);
  const lastLoaded = useRef(initialLastLoaded);
  const resident = useRef(new Set<string>());
  useEffect(() => {
    if (manualOrder.current) save('sessions', ACTIVE_ORDER, JSON.stringify(activeOrder));
  }, [activeOrder]);
  const [maxLoaded, setMaxLoaded] = useState<number | undefined>(undefined);
  /** Sessions being resumed, which is neither loaded nor not and is worth saying. */
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  /** Sessions with a turn running, whichever one is on screen. */
  const [working, setWorking] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!manualOrder.current) return;
    const maintainOrder = () => {
      const now = Date.now();
      const active = new Set(sessions.filter((session) => session.loaded).map((session) => session.sessionId));
      for (const id of loading) active.add(id);
      for (const id of resident.current) {
        if (!active.has(id)) lastLoaded.current[id] = now;
      }
      resident.current = active;
      const kept = activeOrder.filter((id) => {
        if (active.has(id) || lastLoaded.current[id] === undefined) lastLoaded.current[id] = now;
        return now - lastLoaded.current[id] < ORDER_RETENTION;
      });
      lastLoaded.current = Object.fromEntries(kept.map((id) => [id, lastLoaded.current[id]]));
      save('sessions', ACTIVE_SEEN, JSON.stringify(lastLoaded.current));
      if (kept.length !== activeOrder.length) setActiveOrder(kept);
    };
    maintainOrder();
    const timer = window.setInterval(maintainOrder, 60_000);
    return () => window.clearInterval(timer);
  }, [activeOrder, sessions, loading]);
  /**
   * Sessions taken out of the list before disk agrees.
   *
   * Deleting is the slow kind of disk work - a large session is a gigabyte of event log and
   * thousands of snapshot blobs - and waiting for it before redrawing left a row someone had
   * just confirmed the deletion of sitting there, for longer the larger the session was.
   */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());

  const refresh = useCallback(() => {
    /*
     * The list itself, so a caller that needs it to contain something can look rather than
     * guess. Null when the fetch failed, which is not the same as a list without what was
     * asked about: the failure has already been reported, and treating it as an answer
     * would have the caller report it a second time as something else (#227).
     */
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
        return result.sessions;
      })
      .catch((e: unknown) => {
        onError(String(e));
        return null;
      });
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
  const observeLoaded = useCallback((sessionId: string, loaded: boolean, loading = false) => {
    const expired = !resident.current.has(sessionId) && lastLoaded.current[sessionId] !== undefined
      && Date.now() - lastLoaded.current[sessionId] >= ORDER_RETENTION;
    if (loaded || loading) resident.current.add(sessionId);
    else resident.current.delete(sessionId);
    lastLoaded.current[sessionId] = Date.now();
    // Said before anything else, because a resume reports itself starting before it reports
    // itself done and the row should show it for the whole of that rather than at the end.
    setLoading((current) => {
      if (current.has(sessionId) === loading) return current;
      const next = new Set(current);
      if (loading) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });

    setSessions((current) =>
      current.map((session) => (session.sessionId === sessionId ? { ...session, loaded } : session)),
    );

    // New sessions enter at the top, but manually arranged sessions keep their slots across unloads
    setActiveOrder((current) => {
      const order = expired ? current.filter((id) => id !== sessionId) : current;
      return loaded || loading
        ? order.includes(sessionId) ? order : [sessionId, ...order]
        : manualOrder.current ? order : order.filter((id) => id !== sessionId);
    });

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
    () => orderSessions(sessions, activeOrder, loading).filter((session) => !dropped.has(session.sessionId)),
    [sessions, activeOrder, dropped, loading],
  );

  const find = useCallback(
    (sessionId: string | null) => all.find((session) => session.sessionId === sessionId) ?? null,
    [all],
  );

  const reorder = useCallback((sessionId: string, targetId: string, after = false) => {
    if (sessionId === targetId) return;
    const active = all.filter((session) => session.loaded || loading.has(session.sessionId)).map((session) => session.sessionId);
    if (!active.includes(sessionId) || !active.includes(targetId)) return;
    manualOrder.current = true;
    setActiveOrder((current) => {
      const order = [...current, ...active.filter((id) => !current.includes(id))].filter((id) => id !== sessionId);
      order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, sessionId);
      return order;
    });
  }, [all, loading]);

  return { all, find, maxLoaded, working, loading, refresh, drop, restore, observe, observeLoaded, reorder };
}
