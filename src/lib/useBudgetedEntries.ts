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
 * How much a session in use may reach back through before it is trimmed to fit.
 *
 * The opening budget is what a session should *start* at; a reader who has been working in
 * one wants more than two screens behind them without paying for a fetch. Four times it is
 * about eight screens, and measured across 24 real sessions comes to 71 drawn rows at the
 * median and 125 at the worst.
 *
 * What that costs per streamed chunk, from the two measurements already recorded in
 * `useTranscript` - 24 rows at 4ms, 1706 at 27ms, 6771 at 152ms - is about 0.02ms a row on
 * roughly 3.7ms of fixed cost. So 71 rows is near 5ms and 349 (the worst case at twelve
 * times the budget) is near 11ms: at these sizes the rows are not what the chunk is paying
 * for. The ceiling could be higher on that evidence, and is not, because every row trimmed
 * away is markdown that has to be parsed again if the reader scrolls back to it.
 */
export const REACH_BUDGET = 4 * DRAWN_BUDGET;

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
 * The window only ever grows while the reader is anywhere but the bottom. A streamed reply
 * arriving would otherwise push older entries off the top as they watched, and older history
 * fetched from disk would be dropped the moment it arrived - both of which would make the
 * transcript move under whoever is reading it.
 *
 * `settle` is how it comes back down, and the caller decides when: growing without limit is
 * what made a session slower the longer it was worked in (#184).
 */
export function useBudgetedEntries(sessionId: string, entries: Entry[], budget = DRAWN_BUDGET) {
  const [shown, setShown] = useState(() => budgetedCount(entries, budget));
  /** What the list held last time, so anything added can be kept rather than pushing the top away. */
  const held = useRef(entries.length);
  /** The current list, for `settle`, which runs from a timer rather than from a render. */
  const latest = useRef(entries);
  latest.current = entries;

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

  /**
   * Draw at least this many entries from the end, for something that has to be on the page.
   *
   * The budget decides how much of a page is worth drawing before anybody asks for more,
   * which is the right default and the wrong answer when the reader has already asked for a
   * particular row: a search result landed on a page whose match was above the window, so it
   * was not in the document to be found, and the page settled at its end instead (#30).
   *
   * Only ever grows, like `showMore`. Coming back down is `settle`'s job, and it happens
   * when the reader returns to the bottom - so the extra rows are paid for while they are
   * being read and given back afterwards.
   */
  const showAtLeast = useCallback((count: number) => {
    setShown((current) => Math.max(current, count));
  }, []);

  /**
   * Come back down to what a session in use should hold.
   *
   * Called when the reader has settled at the bottom, which is the only time this is safe:
   * trimming from the top while someone is reading up there would move the text under them.
   * That is the same reasoning - and the same moment - that already gives back the pages
   * reached by scrolling up.
   *
   * Never grows. `showMore` and the page's own arrivals are the only things that widen the
   * window, so a ceiling above what is currently drawn leaves it alone rather than reaching
   * for entries the reader has not asked for. That is also what keeps this from fighting the
   * auto-fill that extends a page too short to scroll: this can only ever shorten, and a
   * list holding 64 KB of text is many times any viewport, so the two cannot take turns.
   */
  const settle = useCallback((ceiling = REACH_BUDGET) => {
    const fits = budgetedCount(latest.current, ceiling);
    setShown((current) => Math.min(current, fits));
  }, []);

  const from = Math.max(0, entries.length - shown);
  return { entries: from === 0 ? entries : entries.slice(from), hasMore: from > 0, showMore, showAtLeast, settle };
}
