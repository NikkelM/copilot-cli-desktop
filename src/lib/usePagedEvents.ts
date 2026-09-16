import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';

/**
 * How many events a view draws before the reader asks for more.
 *
 * The same number the session transcript opens with, and for the same reason: the cost of a
 * transcript is not the events but the rows built from them, and markdown runs about nine
 * milliseconds per kilobyte. One real subagent here produces 455 entries, which is three
 * times what the session view would ever draw at once.
 */
export const PAGE = 150;

/**
 * Draw the end of a long list, and reach back through it on request.
 *
 * Unlike the session transcript's paging there is nothing to fetch: a subagent's events are
 * already held, so this is a window over them rather than a trip to disk. What it buys is
 * the same thing - a view that opens at the speed of a screenful rather than of everything
 * that ever happened (#178).
 */
export function usePagedEvents(key: string | null, events: TranscriptEvent[], page = PAGE) {
  const [shown, setShown] = useState(page);

  // A different list is a different position in it: opening one subagent after reaching
  // back through another would otherwise start halfway up.
  useEffect(() => setShown(page), [key, page]);

  const windowed = useMemo(
    () => (events.length > shown ? events.slice(-shown) : events),
    [events, shown],
  );

  const loadOlder = useCallback(() => setShown((current) => current + page), [page]);

  return { events: windowed, hasOlder: events.length > shown, loadOlder };
}
