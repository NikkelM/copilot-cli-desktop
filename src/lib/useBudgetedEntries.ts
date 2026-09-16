import { useCallback, useEffect, useRef, useState } from 'react';

import type { Entry } from './transcriptEntries';

/**
 * How much text a page hands the markdown renderer before the reader asks for more.
 *
 * Counted in characters rather than events because events are a poor proxy for work: the
 * same hundred and fifty of them come to 14 KB on one session here and 207 KB on another,
 * a fourteenfold difference for the same nominal page. Markdown runs at roughly nine
 * milliseconds per kilobyte, so that is the difference between a session that opens at once
 * and one that takes most of two seconds.
 *
 * Sixteen thousand is about two screens of conversation, which is what a reader wants in
 * front of them before they start scrolling.
 */
export const DRAWN_BUDGET = 16 * 1024;

/**
 * Entries to show however long they are.
 *
 * One reply can exceed the whole budget on its own, and a page holding nothing because its
 * newest entry is too big would be worse than a slow one.
 */
export const MINIMUM_ENTRIES = 8;

/** Roughly what a row hands the renderer, which is what its cost tracks. */
export function drawnSize(entry: Entry): number {
  if (entry.kind === 'message' || entry.kind === 'reasoning') return entry.body.length;
  return (entry.summary?.length ?? 0) + (entry.output?.length ?? 0) + (entry.patch?.length ?? 0);
}

/** How many entries from the end fit the budget, counting backwards from the newest. */
export function budgetedCount(entries: Entry[], budget = DRAWN_BUDGET, minimum = MINIMUM_ENTRIES): number {
  let drawn = 0;
  let count = 0;

  for (let index = entries.length - 1; index >= 0; index--) {
    drawn += drawnSize(entries[index]!);
    count += 1;
    if (drawn >= budget) break;
  }

  return Math.max(Math.min(minimum, entries.length), count);
}

/**
 * Show the end of a transcript, measured by what it costs to draw rather than by how many
 * events produced it.
 *
 * The window only ever grows. A streamed reply arriving would otherwise push older entries
 * off the top as the reader watched, and older history fetched from disk would be dropped
 * the moment it arrived - both of which would make the transcript move under whoever is
 * reading it.
 */
export function useBudgetedEntries(sessionId: string, entries: Entry[], budget = DRAWN_BUDGET) {
  const [shown, setShown] = useState(() => budgetedCount(entries, budget));
  /** What the list held last time, so anything added can be kept rather than pushing the top away. */
  const held = useRef(entries.length);

  // A different session is a different transcript: what was reached back through in the
  // last one says nothing about where this one should open.
  useEffect(() => {
    setShown(budgetedCount(entries, budget));
    held.current = entries.length;
    // Only when the session changes: recomputing as entries arrive is what would make the
    // window shrink under a streamed reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    /**
     * The opening page, which arrives a moment after the session is selected rather than
     * with it: the transcript empties itself on selection and fills once the read returns.
     *
     * Read as growth, the whole page was kept - so the budget never applied to a session
     * transcript at all, only to a subagent's, whose events are already in hand when the
     * view mounts. Measured across 204 real sessions: 166 opening pages were over budget,
     * and the budget would have drawn 27% of the entries it was actually handed.
     */
    if (held.current === 0) {
      held.current = entries.length;
      setShown(budgetedCount(entries, budget));
      return;
    }

    const grown = entries.length - held.current;
    held.current = entries.length;

    /**
     * Shorter than it was, which giving back history and switching thinking off both do.
     *
     * Budgeted again rather than adjusted. Holding the old number let every shrink and
     * regrow widen the window a little more - ten rounds of ctrl+t took a transcript from
     * sixteen entries to thirty-five - and each of the two callers that shortens the list
     * wants a fresh budget anyway: giving back history happens at the bottom, and hiding
     * thinking is asking to be charged for less.
     */
    if (grown < 0) setShown(budgetedCount(entries, budget));
    else if (grown > 0) setShown((current) => current + grown);
    // Only the length: the budget is applied once per page rather than per entry, and
    // recomputing as entries arrive is what would make the window shrink under a reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length]);

  const showMore = useCallback(() => setShown((current) => current + MINIMUM_ENTRIES * 4), []);

  const from = Math.max(0, entries.length - shown);
  return { entries: from === 0 ? entries : entries.slice(from), hasMore: from > 0, showMore };
}
