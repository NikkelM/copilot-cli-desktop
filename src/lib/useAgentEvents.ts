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

  /*
   * The log, once it can be shown to hold the whole run.
   *
   * `subagent.started` is the announcement that opened the run and an outcome is what ended
   * it, so a read carrying both has the run from end to end: there is nothing of this
   * agent's left to arrive, and the log attributes every event it returns by asking who
   * produced it.
   *
   * That makes it the better copy outright rather than merely the longer one. The rule below
   * preferred whichever had more events, which is the wrong question when the live copy may
   * be carrying something that is not this agent's work at all: more of it is not better, it
   * is worse, and it wins (#262).
   *
   * The outcome is half of that test rather than the start alone, which froze the view of a
   * run still working: the log is read once, when the view opens, and a run that has not
   * finished goes on being written afterwards. Preferring a copy that cannot grow over the
   * one the events are arriving on meant the reader saw the run as it was at the moment they
   * opened it, and had to leave and come back to see it move.
   */
  const whole =
    read.events.some((event) => event.type === 'subagent.started') &&
    read.events.some((event) => event.type === 'subagent.completed' || event.type === 'subagent.failed');
  if (whole) return read.events;

  // Neither can be shown to be whole, so the fuller one wins. Counted against what the log
  // is able to hold: the live stream carries a run's machinery too, and the log carries only
  // what is drawn.
  return read.events.length >= held.filter((event) => showsInTranscript(event.type, event.data)).length
    ? read.events
    : held;
}
