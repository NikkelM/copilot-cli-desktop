import { formatElapsed } from '../lib/time';
import { useElapsed, useRemaining } from '../lib/useElapsed';

/** Below this, a duration is noise: it appears, says "1s", and is gone. */
const WORTH_SAYING_MS = 2000;

/**
 * The floor the CLI puts on a tool call's duration, which this app matches (#264).
 *
 * Higher than the one above, and deliberately: the composer's counter answers "is this
 * progressing", where two seconds of silence is already worth breaking. A tool row is a
 * record of how long something took, and a transcript where most rows carry a number is one
 * where the number stops meaning "this was slow".
 *
 * Read out of the CLI rather than chosen: its own constant is 5000, applied to a finished
 * call and to one still running alike.
 */
export const TOOL_DURATION_MS = 5000;

/**
 * How long something took, or has been taking.
 *
 * Its own component so the clock behind it belongs to the one row that shows it. A ticking
 * value held any higher would re-render every row in the transcript once a second, at a
 * cost that grows with the length of the conversation rather than with how much is running.
 */
export function Elapsed({ since, until, floor = WORTH_SAYING_MS }: { since?: string; until?: string; floor?: number }) {
  const ms = useElapsed(since, until);
  if (ms === null || ms < floor) return null;

  return <span className="elapsed">{formatElapsed(ms)}</span>;
}

/**
 * Only worth saying once it is close: a wait with four minutes left is not a deadline, it
 * is a wait, and a countdown running the whole time reads as pressure rather than warning.
 */
const WORTH_WARNING_MS = 60_000;

/**
 * How long is left before a request lapses.
 *
 * A blocked agent is the one wait that ends badly if nobody notices it: once the wait runs
 * out the request answers itself as "user not available" and the turn carries on without
 * whatever was being asked for. Silent until the last minute, then insistent (#70).
 *
 * Silent altogether when nothing will lapse, which is what a reader who turned the wait off
 * asked for: there is no deadline to warn about.
 */
export function Expiry({ at }: { at?: string | null }) {
  const ms = useRemaining(at);
  if (ms === null || ms > WORTH_WARNING_MS) return null;

  // Rounded up, unlike a duration counting the other way: "1s left" should stand until the
  // second is actually gone, and flooring would skip it entirely.
  return (
    <span className="expiry" title="Answered automatically when this runs out">
      {ms === 0 ? 'expired' : `${formatElapsed(Math.ceil(ms / 1000) * 1000)} left`}
    </span>
  );
}
