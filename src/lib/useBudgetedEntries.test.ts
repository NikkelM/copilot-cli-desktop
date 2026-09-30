// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  DRAWN_BUDGET,
  MINIMUM_ENTRIES,
  REACH_BUDGET,
  budgetedCount,
  drawnSize,
  useBudgetedEntries,
} from './useBudgetedEntries';
import type { Entry } from './transcriptEntries';

const message = (key: string, length: number): Entry => ({
  kind: 'message',
  key,
  variant: 'assistant',
  body: 'x'.repeat(length),
});

const tool = (key: string, summary: number, output: number): Entry => ({
  kind: 'tool',
  key,
  name: 'powershell',
  summary: 'x'.repeat(summary),
  output: 'x'.repeat(output),
  status: 'ok',
});

const many = (count: number, each = 1024) =>
  Array.from({ length: count }, (_, index) => message(`m${index}`, each));

describe('what a row costs to draw', () => {
  it('measures a message by its body', () => {
    expect(drawnSize(message('m1', 500))).toBe(500);
  });

  /** A tool row draws its summary and its output, and its patch when it has one. */
  it('measures a tool row by everything it puts on screen', () => {
    expect(drawnSize(tool('t1', 100, 900))).toBe(1000);
  });
});

describe('budgeting a page by what it draws', () => {
  /**
   * The finding this exists for: the same hundred and fifty events come to 14 KB on one
   * real session and 207 KB on another, so counting events says nothing about cost.
   */
  it('takes fewer long entries than short ones for the same budget', () => {
    const long = budgetedCount(many(500, 4096));
    const short = budgetedCount(many(500, 256));

    expect(long).toBeLessThan(short);
  });

  it('stops once the budget is met', () => {
    const count = budgetedCount(many(500, 1024), 8 * 1024);

    expect(count).toBe(8);
  });

  it('takes everything when there is less than a budget of it', () => {
    expect(budgetedCount(many(3, 100))).toBe(3);
  });

  /** A page holding nothing because its newest reply is enormous would be worse than a slow one. */
  it('shows a minimum however long the entries are', () => {
    expect(budgetedCount(many(50, DRAWN_BUDGET * 2))).toBe(MINIMUM_ENTRIES);
  });

  it('does not invent entries that are not there', () => {
    expect(budgetedCount(many(2, DRAWN_BUDGET * 2))).toBe(2);
  });
});

describe('showing the end of a transcript', () => {
  it('opens on the newest entries', () => {
    const entries = many(200, 1024);
    const { result } = renderHook(() => useBudgetedEntries('s1', entries));

    expect(result.current.entries).toHaveLength(16);
    expect(result.current.entries[result.current.entries.length - 1]?.key).toBe('m199');
    expect(result.current.hasMore).toBe(true);
  });

  it('reaches back through what is already built', () => {
    const entries = many(200, 1024);
    const { result } = renderHook(() => useBudgetedEntries('s1', entries));
    const before = result.current.entries.length;

    act(() => result.current.showMore());

    expect(result.current.entries.length).toBeGreaterThan(before);
  });

  it('says there is no more once everything is shown', () => {
    const { result } = renderHook(() => useBudgetedEntries('s1', many(4, 100)));

    expect(result.current.hasMore).toBe(false);
  });

  /**
   * The window only grows. Recomputing it as entries arrive would push older ones off the
   * top while a reply streamed in, moving the transcript under whoever was reading it.
   */
  it('keeps what it is showing when a new entry arrives', () => {
    const { result, rerender } = renderHook(({ entries }) => useBudgetedEntries('s1', entries), {
      initialProps: { entries: many(200, 1024) },
    });
    const before = result.current.entries.length;

    rerender({ entries: many(201, 1024) });

    expect(result.current.entries.length).toBe(before + 1);
  });

  // Older history fetched from disk must not be dropped the moment it arrives.
  it('keeps older history once it is prepended', () => {
    const { result, rerender } = renderHook(({ entries }) => useBudgetedEntries('s1', entries), {
      initialProps: { entries: many(50, 1024) },
    });
    const before = result.current.entries.length;

    rerender({ entries: [...many(30, 1024), ...many(50, 1024)] });

    expect(result.current.entries.length).toBe(before + 30);
  });

  /** A different session is a different transcript, and opens at its own end. */
  it('starts again at the end for another session', () => {
    const { result, rerender } = renderHook(({ id, entries }) => useBudgetedEntries(id, entries), {
      initialProps: { id: 's1', entries: many(200, 1024) },
    });
    act(() => result.current.showMore());
    const reached = result.current.entries.length;

    rerender({ id: 's2', entries: many(200, 1024) });

    expect(result.current.entries.length).toBeLessThan(reached);
  });
});

/**
 * How a session transcript actually arrives, which is not how any test above delivers it.
 *
 * Selecting a session empties the transcript and fills it one read later, so the hook is
 * mounted against nothing and handed the opening page afterwards. Read as growth that page
 * was kept whole, and the budget never applied to a session transcript at all - only to a
 * subagent's, whose events are in hand before its view mounts. Measured across 204 real
 * sessions, 166 opening pages were over budget.
 */
describe('a page that arrives after the view does', () => {
  it('budgets the first page rather than keeping all of it', () => {
    const { result, rerender } = renderHook(({ entries }) => useBudgetedEntries('s1', entries), {
      initialProps: { entries: [] as Entry[] },
    });

    rerender({ entries: many(150, 1400) });

    expect(result.current.entries.length).toBe(budgetedCount(many(150, 1400)));
    expect(result.current.hasMore).toBe(true);
  });

  /** The whole sequence a session switch produces: the old list, then nothing, then the new. */
  it('budgets the page that replaces another session', () => {
    const { result, rerender } = renderHook(({ id, entries }) => useBudgetedEntries(id, entries), {
      initialProps: { id: 's1', entries: many(150, 1400) },
    });

    rerender({ id: 's2', entries: [] as Entry[] });
    rerender({ id: 's2', entries: many(150, 1400) });

    expect(result.current.entries.length).toBe(budgetedCount(many(150, 1400)));
  });

  // A live event after the page has been budgeted is growth like any other.
  it('still keeps what it shows once the page has arrived', () => {
    const { result, rerender } = renderHook(({ entries }) => useBudgetedEntries('s1', entries), {
      initialProps: { entries: [] as Entry[] },
    });
    rerender({ entries: many(150, 1400) });
    const opened = result.current.entries.length;

    rerender({ entries: many(151, 1400) });

    expect(result.current.entries.length).toBe(opened + 1);
  });
});

/**
 * Giving back history and switching thinking off both shorten the list. Keeping the old
 * number through a shrink let every shrink-and-regrow widen the window a little more, until
 * a long session drew all of itself.
 */
describe('a transcript that gets shorter', () => {
  it('does not widen the window by shrinking and growing again', () => {
    const { result, rerender } = renderHook(({ entries }) => useBudgetedEntries('s1', entries), {
      initialProps: { entries: many(200, 1024) },
    });
    // Thinking switched off and back on, which is the cheapest way to reach this.
    const cycle = () => {
      rerender({ entries: many(198, 1024) });
      rerender({ entries: many(200, 1024) });
    };

    cycle();
    const afterOne = result.current.entries.length;
    for (let round = 0; round < 9; round++) cycle();

    expect(result.current.entries.length).toBe(afterOne);
  });
});


/**
 * The bug this exists for: the window grew for as long as the reader stayed in the session,
 * and only leaving and coming back brought it down (#184).
 */
describe('coming back down once the reader settles at the bottom', () => {
  /** A page that has grown well past what a session in use should hold. */
  const grown = () => {
    const { result, rerender } = renderHook(({ entries }) => useBudgetedEntries('s1', entries), {
      initialProps: { entries: many(4) },
    });
    // Arriving rather than mounted, which is how a session transcript actually fills.
    rerender({ entries: many(400) });
    return { result, rerender };
  };

  it('draws everything that arrived, before anything settles', () => {
    const { result } = grown();

    expect(result.current.entries).toHaveLength(400);
  });

  it('comes back to the reach budget', () => {
    const { result } = grown();

    act(() => result.current.settle());

    expect(result.current.entries).toHaveLength(budgetedCount(many(400), REACH_BUDGET));
  });

  it('holds more than a session opens with, because the reader has been working in it', () => {
    const { result } = grown();

    act(() => result.current.settle());

    expect(result.current.entries.length).toBeGreaterThan(budgetedCount(many(400), DRAWN_BUDGET));
  });

  it('keeps the newest entries, which are the ones being read', () => {
    const { result } = grown();

    act(() => result.current.settle());

    expect(result.current.entries[result.current.entries.length - 1]?.key).toBe('m399');
  });

  it('says there is more above it', () => {
    const { result } = grown();

    act(() => result.current.settle());

    expect(result.current.hasMore).toBe(true);
  });

  /**
   * Settling is a ceiling, not a target. Reaching for entries the reader never asked for
   * would make a session that just opened draw four times as much for having paused.
   */
  it('leaves a window below the ceiling exactly where it was', () => {
    const { result } = renderHook(() => useBudgetedEntries('s1', many(400)));
    const opened = result.current.entries.length;
    expect(opened).toBe(budgetedCount(many(400), DRAWN_BUDGET));

    act(() => result.current.settle());

    expect(result.current.entries).toHaveLength(opened);
  });

  it('leaves a window already under the ceiling alone', () => {
    const { result } = renderHook(() => useBudgetedEntries('s1', many(4)));
    const before = result.current.entries.length;

    act(() => result.current.settle());

    expect(result.current.entries).toHaveLength(before);
  });

  it('does not undo a reader who asked for more, below the ceiling', () => {
    const { result } = renderHook(() => useBudgetedEntries('s1', many(400, 16)));
    act(() => result.current.showMore());
    const asked = result.current.entries.length;

    act(() => result.current.settle());

    expect(result.current.entries).toHaveLength(asked);
  });

  it('does trim a reader who asked for more, past the ceiling', () => {
    const { result } = grown();
    act(() => result.current.showMore());

    act(() => result.current.settle());

    expect(result.current.entries.length).toBeLessThan(400);
  });

  /**
   * The budget counts text, and a tool row holds far more of it than it draws - its output
   * is collapsed. So a page can be many times over budget and barely taller than its box,
   * and trimming it to the budget leaves it too short to scroll. The auto-fill that keeps
   * such a page reachable then widens it straight back, and the page visibly vanishes and
   * returns (#232).
   */
  describe('what the view needs, whatever the budget says', () => {
    it('keeps what fills the view even where the budget is long past', () => {
      const { result } = grown();
      const over = result.current.entries.length;

      act(() => result.current.settle(undefined, over));

      expect(result.current.entries).toHaveLength(over);
    });

    it('trims to the floor rather than all the way to the budget', () => {
      const { result } = grown();
      act(() => result.current.showMore());
      const asked = result.current.entries.length;
      // Between the two, which is the case that tells them apart: the budget would cut
      // further than this, and the reader is currently drawing more.
      act(() => result.current.settle());
      const budgeted = result.current.entries.length;
      expect(budgeted).toBeLessThan(asked);

      const { result: again } = grown();
      act(() => again.current.showMore());
      act(() => again.current.settle(undefined, budgeted + 10));

      expect(again.current.entries).toHaveLength(budgeted + 10);
    });

    /** A floor under what the budget allows is not a reason to draw less than the budget. */
    it('still keeps the budget where the view needs less than it', () => {
      const { result } = grown();
      act(() => result.current.settle());
      const budgeted = result.current.entries.length;

      act(() => result.current.settle(undefined, 1));

      expect(result.current.entries).toHaveLength(budgeted);
    });

    it('trims as it always did when the view asks for nothing', () => {
      const { result } = grown();

      act(() => result.current.settle(undefined, 0));

      expect(result.current.entries.length).toBeLessThan(400);
    });

    /** Only ever shortens, so a floor above what is drawn is not a way to reach further back. */
    it('is not a way to widen the window', () => {
      const { result } = renderHook(() => useBudgetedEntries('s1', many(400, 16)));
      const drawn = result.current.entries.length;

      act(() => result.current.settle(undefined, drawn + 50));

      expect(result.current.entries).toHaveLength(drawn);
    });
  });

  /** Streaming carries on afterwards, and must still be followed. */
  it('keeps up with what arrives after it has settled', () => {
    const { result, rerender } = grown();
    act(() => result.current.settle());
    const after = result.current.entries.length;

    rerender({ entries: many(410) });

    expect(result.current.entries).toHaveLength(after + 10);
    expect(result.current.entries[result.current.entries.length - 1]?.key).toBe('m409');
  });

  it('can settle again as the session goes on growing', () => {
    const { result, rerender } = grown();
    act(() => result.current.settle());
    rerender({ entries: many(800) });

    act(() => result.current.settle());

    expect(result.current.entries).toHaveLength(budgetedCount(many(800), REACH_BUDGET));
  });

  it('takes the ceiling it is given', () => {
    const { result } = grown();

    act(() => result.current.settle(DRAWN_BUDGET));

    expect(result.current.entries).toHaveLength(budgetedCount(many(400), DRAWN_BUDGET));
  });

  /** A settle armed in one session must not measure the next one's transcript. */
  it('budgets against the list it is holding now', () => {
    const { result, rerender } = renderHook(({ entries }) => useBudgetedEntries('s1', entries), {
      initialProps: { entries: many(400) },
    });
    rerender({ entries: many(3) });

    act(() => result.current.settle());

    expect(result.current.entries).toHaveLength(3);
  });
});

