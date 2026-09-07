import { formatElapsed } from '../lib/time';
import { useElapsed } from '../lib/useElapsed';

/** Below this, a duration is noise: it appears, says "1s", and is gone. */
const WORTH_SAYING_MS = 2000;

/**
 * How long something took, or has been taking.
 *
 * Its own component so the clock behind it belongs to the one row that shows it. A ticking
 * value held any higher would re-render every row in the transcript once a second, at a
 * cost that grows with the length of the conversation rather than with how much is running.
 */
export function Elapsed({ since, until }: { since?: string; until?: string }) {
  const ms = useElapsed(since, until);
  if (ms === null || ms < WORTH_SAYING_MS) return null;

  return <span className="elapsed">{formatElapsed(ms)}</span>;
}
