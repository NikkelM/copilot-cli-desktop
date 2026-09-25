/** What the sidecar wraps a match in. Control characters, so no typed text can imitate them. */
export const OPEN = '\u0002';
export const SHUT = '\u0003';

/**
 * Split an excerpt into the parts that matched and the parts around them.
 *
 * Apart from the component that draws it so that file exports a component and nothing else,
 * which is what React's fast refresh needs to swap it without reloading the page.
 *
 * The marks arrive from SQLite rather than from this app, so an unpaired one is handled
 * rather than trusted. A run with no closing mark is taken as matched to its end, which draws
 * too much rather than silently dropping the rest of the line.
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

/** The excerpt as it reads without the marks, for a title a reader can hover for the whole of it. */
export function unmarked(excerpt: string): string {
  return excerpt.split(OPEN).join('').split(SHUT).join('');
}
