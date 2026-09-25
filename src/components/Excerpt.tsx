import { marked, unmarked } from '../lib/excerpt';
import type { SessionMatch } from '../../shared/protocol';

/**
 * The words around what a session said, under the row that said them.
 *
 * Only for a row that would not be here otherwise. A session found by its title needs no
 * explaining, and an excerpt under every row would turn a list into a wall of prose.
 */
export function Excerpt({ match }: { match: SessionMatch | undefined }) {
  if (!match?.excerpt) return null;
  const { excerpt } = match;

  return (
    <p className="session-excerpt" title={unmarked(excerpt)}>
      {marked(excerpt).map((part, index) =>
        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </p>
  );
}
