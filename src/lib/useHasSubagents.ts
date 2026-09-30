import { useCallback, useRef, useState } from 'react';

import { sessionAgents } from './sidecar';

/**
 * Whether a session delegated anything, for the menu entry that offers to list them (#228).
 *
 * Asked rather than known. Nothing records it: the database's `assistant_usage_events` has
 * an `agent_id`, but the table is recent, and against fifty real sessions it disagreed with
 * the logs on half of them - always by claiming none where the log had some. Greying out on
 * that would have hidden the feature from exactly the sessions that needed it.
 *
 * So the log is asked, and the answer is only believed when it is certain. A read that
 * reaches the start of a log and finds nothing proves there is nothing; one that stops at
 * its ceiling proves nothing at all, and leaves the entry enabled.
 *
 * That asymmetry is what makes this affordable. Only a log small enough to be read whole
 * can answer "none", and 93% of the logs here are: the largest of them reads in 51 ms,
 * against 1.9 seconds for the largest log overall - which is in the 7% that answer nothing
 * and leave the entry alone.
 */
export function useHasSubagents() {
  const [none, setNone] = useState<ReadonlySet<string>>(() => new Set());
  /** Who has been asked about, so a menu opened twice does not ask twice. */
  const asked = useRef(new Set<string>());

  const check = useCallback((sessionId: string) => {
    if (asked.current.has(sessionId)) return;
    asked.current.add(sessionId);

    sessionAgents(sessionId, 1)
      .then((page) => {
        // Nothing found and nothing left to look at, which is the only certain answer.
        if (page.agents.length === 0 && !page.truncated) {
          setNone((current) => new Set(current).add(sessionId));
        }
      })
      // An unreadable log says nothing about what is in it, so the entry stays offered.
      .catch(() => asked.current.delete(sessionId));
  }, []);

  return {
    check,
    /** Only ever true for a session whose whole log was read and held nothing. */
    hasNone: (sessionId: string) => none.has(sessionId),
  };
}
