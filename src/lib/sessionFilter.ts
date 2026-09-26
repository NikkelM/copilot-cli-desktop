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

/**
 * Why a row is in the list, when the thing it matched is not on the row.
 *
 * A row shows its title, its repository and its tags. It does not show the working
 * directory, the branch or the id - so a session that matched one of those arrives looking
 * unexplained, which is how a branch called `feature/npc-assist-traits` put three sessions
 * under a search for "assist" with nothing to see.
 *
 * Marked up the way a transcript excerpt is, so the part that matched reads the same
 * wherever it came from. Null when the reason is already on the row.
 */
export function hiddenReason(session: SessionSummary, query: Query): string | null {
  if (!query.text) return null;

  // Title and repository are drawn on the row, so a match there explains itself.
  for (const field of [session.cwd, session.branch]) {
    const at = field?.toLowerCase().indexOf(query.text) ?? -1;
    if (at >= 0 && field) {
      return `${field.slice(0, at)}\u0002${field.slice(at, at + query.text.length)}\u0003${field.slice(at + query.text.length)}`;
    }
  }

  if (session.sessionId.toLowerCase().startsWith(query.text)) {
    return `\u0002${session.sessionId.slice(0, query.text.length)}\u0003${session.sessionId.slice(query.text.length)}`;
  }

  return null;
}
