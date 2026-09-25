import type { SessionMatch } from '../../shared/protocol';

/** What the sidecar wraps a match in. Control characters, so no typed text can imitate them. */
const OPEN = '\u0002';
const SHUT = '\u0003';

/**
 * Split an excerpt into the parts that matched and the parts around them.
 *
 * Exported for its own sake: the marks arrive from SQLite rather than from this app, and an
 * unpaired one is worth handling rather than trusting. A run with no closing mark is taken as
 * matched to its end, which draws too much rather than silently dropping the rest of the line.
 */
export function marked(excerpt: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];

  for (const [index, chunk] of excerpt.split(OPEN).entries()) {
    if (index === 0) {
      if (chunk) parts.push({ text: chunk, hit: false });
      continue;
    }

    const shut = chunk.indexOf(SHUT);
    if (shut < 0) {
      if (chunk) parts.push({ text: chunk, hit: true });
      continue;
    }

    if (shut > 0) parts.push({ text: chunk.slice(0, shut), hit: true });
    const after = chunk.slice(shut + 1);
    if (after) parts.push({ text: after, hit: false });
  }

  return parts;
}

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
    <p className="session-excerpt" title={excerpt.split(OPEN).join('').split(SHUT).join('')}>
      {marked(excerpt).map((part, index) =>
        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </p>
  );
}
