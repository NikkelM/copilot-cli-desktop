import { useEffect, useState } from 'react';

import { ageOf, formatRelative } from './time';

/** As often as a relative time can change while it is still counted in seconds. */
const TICK_MS = 15_000;

/** Past this, the answer changes once an hour at most and there is nothing to follow. */
const STOPS_MOVING_MS = 3_600_000;

/**
 * How long ago something was, kept current while that still changes.
 *
 * A row drawn as "1s ago" and left alone said so for as long as the window stayed open,
 * which is worse than stale: it is a wrong answer stated confidently. Only the first hour
 * is followed, so a transcript of a hundred old messages costs no timers at all.
 */
export function useRelative(iso: string | undefined): string {
  const [, tick] = useState(0);

  useEffect(() => {
    if (!iso || ageOf(iso) > STOPS_MOVING_MS) return;

    const timer = setInterval(() => tick((count) => count + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [iso]);

  return iso ? formatRelative(iso) : '';
}
