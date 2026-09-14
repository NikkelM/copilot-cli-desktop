import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionContextUsage, TranscriptEvent } from '../../shared/protocol';

import { sessionContext } from './sidecar';

/**
 * How full the open session's context window is.
 *
 * Only ever answerable for a session the runtime already holds. The runtime emits its usage
 * figures live and never writes them to the event log, so unlike the model - which a cold
 * session can name from its own history - there is nothing on disk to read here, and resuming
 * a session to find out how full it is would cost the thing this app exists to avoid. A cold
 * session therefore shows no meter at all, which is honest: it is occupying no window.
 *
 * Asked for rather than followed, because the runtime's own `session.usage_info` fires on
 * every model call within a request. A request that calls tools nine times would ask nine
 * times over for a number the reader sees change once.
 */
export function useContextUsage(sessionId: string | null) {
  const [usage, setUsage] = useState<SessionContextUsage | null>(null);

  const showing = useRef(sessionId);
  showing.current = sessionId;

  /** Reads in flight, so a slow answer cannot overwrite a newer one. */
  const reading = useRef(0);

  const refresh = useCallback(() => {
    const forSession = showing.current;
    if (!forSession) return;

    const at = ++reading.current;
    sessionContext(forSession)
      .then((found) => {
        if (reading.current === at && showing.current === forSession) setUsage(found);
      })
      // Not worth the error bar: a window that cannot be measured is not something the
      // reader can act on, and the session going away is the usual reason it cannot be.
      .catch(() => {
        if (reading.current === at) setUsage(null);
      });
  }, []);

  useEffect(() => {
    setUsage(null);
    // Asked for every session opened, not only loaded ones. A cold session is answered from
    // the runtime's own table of what it holds, without touching Copilot, so this costs a
    // round trip to the sidecar and nothing else - and it is the only way a session already
    // awake before the reader arrived gets a meter at all.
    refresh();
  }, [sessionId, refresh]);

  /**
   * Ask again when the window has actually moved.
   *
   * `session.idle` is the end of a whole request rather than one model round trip, so this
   * asks once per reply. Compaction is worth following separately: it is the one thing that
   * makes the number go down, it lands part way through a request, and a reader watching a
   * meter climb towards its limit should see it drop when it does.
   */
  const observe = useCallback(
    (event: TranscriptEvent) => {
      if (event.type === 'session.idle' || event.type === 'session.compaction_complete') refresh();
    },
    [refresh],
  );

  /** A session let go is occupying nothing, and the runtime that held the count went with it. */
  const observeLoaded = useCallback(
    (loaded: boolean) => {
      if (loaded) refresh();
      else {
        reading.current++;
        setUsage(null);
      }
    },
    [refresh],
  );

  return { usage, refresh, observe, observeLoaded };
}
