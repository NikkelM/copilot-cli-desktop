import { useEffect, useRef, useState } from 'react';

import { showsInTranscript, type TranscriptEvent } from '../../shared/protocol';
import { getAgentTranscript } from './sidecar';

/**
 * A subagent's own events, read from the log rather than remembered (#178).
 *
 * The delegating session holds a subagent's work so the row that delegated it can draw it,
 * which is a commitment that grows with every delegation - one run here comes to 3.3 MB.
 * The log already has all of it, and a run is contiguous, so reading one back costs a
 * window near the end of the file rather than a scan: measured at 5 ms against the largest
 * log on this machine, 697 MB.
 *
 * What is held wins until the log can be shown to have at least as much. A run still in
 * flight is being written as it happens, so the log is behind by design, and showing fewer
 * events than the reader could already see would be a regression dressed as a saving.
 */
export function useAgentEvents(
  sessionId: string | null,
  agentId: string | null,
  held: TranscriptEvent[],
): TranscriptEvent[] {
  const [read, setRead] = useState<{ agentId: string; events: TranscriptEvent[] } | null>(null);
  /** Which agent the answer on its way belongs to, so a late one cannot land on another. */
  const asked = useRef(0);

  useEffect(() => {
    asked.current += 1;
    const mine = asked.current;

    if (!sessionId || !agentId) {
      setRead(null);
      return;
    }

    getAgentTranscript(sessionId, agentId)
      .then((result) => {
        if (mine === asked.current) setRead({ agentId, events: result.events });
      })
      // The held events are still there, so a log that cannot be read costs nothing.
      .catch(() => undefined);

    return () => {
      asked.current += 1;
    };
  }, [sessionId, agentId]);

  if (!agentId || read?.agentId !== agentId) return held;

  // What the log can hold against what it holds, rather than against every event watched:
  // the live stream carries a run's machinery too, and the log carries only what is drawn.
  return read.events.length >= held.filter((event) => showsInTranscript(event.type)).length ? read.events : held;
}
