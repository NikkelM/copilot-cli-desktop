import type { SessionSummary } from '../../shared/protocol';
import { normalise } from './useTags';

/**
 * What was typed into the filter box, split into the parts that ask different questions.
 *
 * `tag:` terms are pulled out and the rest is left as one string rather than split into
 * words. Splitting would change what the box has always done: `hades biomes` matches a title
 * containing that phrase, and turning it into two terms that must both appear somewhere
 * would quietly widen every query anyone already types (#123).
 */
export interface Query {
  /** The free text, lowercased. Empty when the query was only tags. */
  text: string;
  /** Tags that must all be present. Normalised, so `Bug` finds `bug`. */
  tags: string[];
}

/** A tag term: `tag:bug`, or `tag:"needs review"` when it has a space in it. */
const TAG_TERM = /tag:("[^"]*"|'[^']*'|\S*)/g;

export function parseQuery(raw: string): Query {
  const tags: string[] = [];

  const text = raw
    .replace(TAG_TERM, (_whole, value: string) => {
      const tag = normalise(value.replace(/^['"]|['"]$/g, ''));
      // `tag:` on its own is someone mid-type, and matching every tagged session as they
      // reach for the name would empty the list and refill it a keystroke later.
      if (tag) tags.push(tag);
      return '';
    })
    .trim()
    .toLowerCase();

  return { text, tags };
}

/**
 * Whether a session answers the query.
 *
 * Every part must match. A reader adding a term is narrowing what they are looking at, which
 * is the only reading that makes adding one useful.
 */
export function matchesQuery(session: SessionSummary, query: Query, tags: readonly string[]): boolean {
  for (const wanted of query.tags) {
    if (!tags.includes(wanted)) return false;
  }

  if (!query.text) return true;

  return (
    [session.title, session.cwd, session.repository, session.branch].some((field) =>
      field?.toLowerCase().includes(query.text),
    ) ||
    // An id is usually quoted by its first characters - in CLI output, in a state directory
    // name, in a commit trailer - so it matches from the start rather than anywhere, which
    // would turn a short query into a match against every session.
    session.sessionId.toLowerCase().startsWith(query.text) ||
    // A tag is worth finding without the prefix too: someone who typed `bug` and got nothing
    // would reasonably conclude the tag had not saved.
    tags.some((tag) => tag.includes(query.text))
  );
}

/** Whether a query asks for anything at all. An empty one matches everything. */
export function isEmpty(query: Query): boolean {
  return query.text === '' && query.tags.length === 0;
}
