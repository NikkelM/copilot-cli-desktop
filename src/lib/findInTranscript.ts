import type { Entry } from './transcriptEntries';

/**
 * Finding a word inside one conversation (#209).
 *
 * Distinct from searching the sessions, which finds *which* session said something. This is
 * for when the reader is already in the right place and the word appears forty times.
 *
 * What is searched is what the row can show, not what it is showing now: a tool call's
 * output counts even while its row is folded, because the reader can see the row and expects
 * the word in it to be found. Landing on one opens it.
 */

/** Everything in an entry a reader could read, as one string to look through. */
export function textOf(entry: Entry): string {
  if (entry.kind === 'message' || entry.kind === 'reasoning') return entry.body;

  return [
    entry.name,
    entry.summary,
    entry.command,
    entry.output,
    entry.answer,
    ...(entry.choices ?? []),
    entry.patch,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Which entries hold the words, oldest first.
 *
 * Indices rather than entries, because what the caller does with a hit is scroll to it and
 * mark it - both of which are about where it sits in the list rather than what it is.
 *
 * One hit per entry however many times the words appear in it. A row is what the reader is
 * taken to, and taking them to the same row three times would read as the walk being stuck.
 */
export function findMatches(entries: readonly Entry[], query: string): number[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];

  const found: number[] = [];
  for (const [index, entry] of entries.entries()) {
    if (textOf(entry).toLowerCase().includes(wanted)) found.push(index);
  }

  return found;
}

/**
 * The next hit to walk to, wrapping at either end.
 *
 * Wrapping because the alternative is a key that stops working at the last match, which
 * reads as broken rather than as finished - and every other find box on the machine wraps.
 */
export function stepMatch(count: number, at: number, by: 1 | -1): number {
  if (count === 0) return -1;
  return (at + by + count) % count;
}
