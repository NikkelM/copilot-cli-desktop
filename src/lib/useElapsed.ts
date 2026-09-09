import { useEffect, useState } from 'react';

/** Once a second is as fine as a duration shown in seconds can usefully be. */
const TICK_MS = 1000;

/**
 * The current time, re-read once a second while something is actually running.
 *
 * Deliberately owned by the row that displays it rather than by anything above: a clock at
 * the top of the transcript would re-render every message in it once a second, and the cost
 * of that grows with the length of the conversation rather than with the number of things
 * actually running.
 *
 * @param active whether anything is still moving; false means no timer at all
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Nothing to count. A timer here would be a wakeup a second forever for no reason.
    if (!active) return;

    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

/**
 * How long something has been going, counted where it is shown.
 *
 * @param since when it started, or null when nothing is running
 * @param until when it ended, for something already over: a finished duration does not tick
 */
export function useElapsed(since: string | null | undefined, until?: string | null): number | null {
  const start = since ? new Date(since).getTime() : Number.NaN;
  const end = until ? new Date(until).getTime() : Number.NaN;
  const now = useNow(Number.isFinite(start) && !Number.isFinite(end));

  if (!Number.isFinite(start)) return null;
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}

/**
 * How long is left before a deadline, or null once there is none or it has passed.
 *
 * The counterpart to `useElapsed` for the one wait that ends badly if nobody notices it: a
 * permission request lapses after five minutes and the turn carries on without it (#70).
 */
export function useRemaining(until: string | null | undefined): number | null {
  const end = until ? new Date(until).getTime() : Number.NaN;
  const now = useNow(Number.isFinite(end));

  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - now);
}
