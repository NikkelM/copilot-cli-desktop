import { marked, unmarked } from '../lib/excerpt';

/**
 * The words around what put a row in the list, under the row itself.
 *
 * Only for a row that would not be here otherwise, or whose reason for being here is not on
 * it. A session found by its title needs no explaining, and a line under every row would
 * turn a list into a wall of prose.
 */
export function Excerpt({ excerpt }: { excerpt: string | undefined }) {
  if (!excerpt) return null;

  return (
    <p className="session-excerpt" title={unmarked(excerpt)}>
      {marked(excerpt).map((part, index) =>
        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </p>
  );
}
