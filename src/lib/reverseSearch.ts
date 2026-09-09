/**
 * A reverse search through the prompts already sent, as readline and the CLI do it.
 *
 * Kept apart from the composer because it is a small state machine with a lot of edges and
 * no need for a DOM to exercise them. Ported from the CLI's own so the two behave alike
 * down to the awkward parts: a search that finds nothing keeps showing the match it had,
 * and stepping back never wraps round to the newest again.
 */
export interface Search {
  /** What has been typed to search for, which is not what is in the box. */
  query: string;
  /** The prompt found, or null before anything has been typed. */
  match: string | null;
  /** Where that prompt sits in the history, or -1 for none. */
  at: number;
  /**
   * Whether the last key found nothing.
   *
   * Separate from `match` being null because they are not the same state: a failed search
   * leaves the previous match on screen and only says that it is now stale, which is what
   * makes it possible to back out a character and carry on.
   */
  failed: boolean;
}

/** The newest prompt at or after `from` that contains `query`, ignoring case. */
function found(history: readonly string[], query: string, from: number): Pick<Search, 'match' | 'at' | 'failed'> {
  if (!query) return { match: null, at: -1, failed: false };

  const wanted = query.toLowerCase();
  for (let i = Math.max(0, from); i < history.length; i++) {
    if (history[i]!.toLowerCase().includes(wanted)) return { match: history[i]!, at: i, failed: false };
  }

  return { match: null, at: -1, failed: true };
}

/** Begin a search. */
export function opened(): Search {
  return { query: '', match: null, at: -1, failed: false };
}

/** Add a character to what is being searched for, starting again from the newest prompt. */
export function typed(search: Search, history: readonly string[], character: string): Search {
  const query = search.query + character;
  const hit = found(history, query, 0);

  // A failed search keeps the match it had rather than emptying: the reader has mistyped a
  // character, and taking the answer away would make backspacing over it feel like a
  // different search rather than the same one continued.
  return hit.failed ? { ...search, query, failed: true } : { ...search, query, ...hit };
}

/** Take back the last character searched for, and with it the failure it may have caused. */
export function erased(search: Search, history: readonly string[]): Search {
  if (!search.query) return search;

  const query = search.query.slice(0, -1);
  return { ...search, query, ...found(history, query, 0) };
}

/** Step back to the next older prompt that matches, staying put once there are no more. */
export function cycled(search: Search, history: readonly string[]): Search {
  if (!search.query) return search;

  const hit = found(history, search.query, search.at + 1);
  return hit.failed ? { ...search, failed: true } : { ...search, ...hit };
}

/**
 * The match split around the part that was searched for, for drawing the highlight.
 *
 * Returns null when there is nothing to draw, so the caller has one thing to check rather
 * than three.
 */
export function highlighted(search: Search): { before: string; hit: string; after: string } | null {
  if (!search.match) return null;

  const at = search.match.toLowerCase().indexOf(search.query.toLowerCase());
  // The query can be absent from the match after a failed key, which is the state that
  // keeps the old match on screen. Show it whole rather than pretending part of it matched.
  if (at === -1) return { before: search.match, hit: '', after: '' };

  return {
    before: search.match.slice(0, at),
    hit: search.match.slice(at, at + search.query.length),
    after: search.match.slice(at + search.query.length),
  };
}
