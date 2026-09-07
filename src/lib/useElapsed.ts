import { useEffect, useState } from 'react';

/** Once a second is as fine as a duration shown in seconds can usefully be. */
const TICK_MS = 1000;

/**
 * How long something has been going, counted where it is shown.
 *
 * Deliberately owned by the row that displays it rather than by anything above: a clock at
 * the top of the transcript would re-render every message in it once a second, and the cost
 * of that grows with the length of the conversation rather than with the number of things
 * actually running.
 *
 * @param since when it started, or null when nothing is running
 * @param until when it ended, for something already over: a finished duration does not tick
 */
export function useElapsed(since: string | null | undefined, until?: string | null): number | null {
  const start = since ? new Date(since).getTime() : Number.NaN;
  const end = until ? new Date(until).getTime() : Number.NaN;

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Nothing to count: either it never started, or it is already over and its length is
    // fixed. A timer in either case would be a wakeup a second forever for no reason.
    if (!Number.isFinite(start) || Number.isFinite(end)) return;

    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [start, end]);

  if (!Number.isFinite(start)) return null;
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}
