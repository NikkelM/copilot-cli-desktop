import { read, save } from './store';

/**
 * How the words are matched, as the three toggles a reader knows from everywhere else.
 *
 * Remembered for every session rather than this one: somebody who searches with a pattern
 * is someone who searches with patterns, and having to say so again in the next session is
 * the sort of thing that stops them using it at all.
 */
export interface FindMode {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const PLAIN: FindMode = { matchCase: false, wholeWord: false, regex: false };

const KEYS: Record<keyof FindMode, string> = {
  matchCase: 'findMatchCase',
  wholeWord: 'findWholeWord',
  regex: 'findRegex',
};

/** How the reader last searched. Off unless they turned it on, as each of these is. */
export function readFindMode(): FindMode {
  return {
    matchCase: read('sessions', KEYS.matchCase) === 'true',
    wholeWord: read('sessions', KEYS.wholeWord) === 'true',
    regex: read('sessions', KEYS.regex) === 'true',
  };
}

export function saveFindMode(mode: FindMode): void {
  for (const key of Object.keys(KEYS) as (keyof FindMode)[]) save('sessions', KEYS[key], String(mode[key]));
}

/** Everything a regular expression reads as syntax, for a query that is not one. */
function literal(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The query as something to match with, or null when it is not one.
 *
 * Null for an empty query and for a pattern that will not compile, which is the one case the
 * bar has to show: everything else a reader types is a valid search for nothing.
 *
 * Global, because the word marks walk text looking for every mention - so every caller has
 * to put `lastIndex` back before each thing it tests. A shared regular expression that
 * remembers where it got to is the oldest bug in this corner of the language.
 */
export function matcher(query: string, mode: FindMode = PLAIN): RegExp | null {
  const wanted = query.trim();
  if (!wanted) return null;

  const source = mode.regex ? wanted : literal(wanted);
  // Round the whole pattern rather than each alternative, which is what every other find box
  // does: `\bfoo|bar\b` would mean a whole `foo` or a `bar` ending a word.
  const bounded = mode.wholeWord ? `\\b(?:${source})\\b` : source;

  try {
    return new RegExp(bounded, mode.matchCase ? 'g' : 'gi');
  } catch {
    // A half-typed pattern is not a failure worth reporting anywhere but in the box.
    return null;
  }
}

/** Whether what was typed is a pattern that will not compile, which the box says in red. */
export function broken(query: string, mode: FindMode): boolean {
  return query.trim() !== '' && matcher(query, mode) === null;
}
