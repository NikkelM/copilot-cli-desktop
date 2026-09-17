/**
 * Frontmatter, which both sides of the wire have to read the same way.
 *
 * The sidecar splits a page it read from disk; the app splits a page being edited, so it can
 * preview unsaved work without a round trip. Two implementations of this would eventually
 * disagree about where a page begins, and the page would render differently depending on
 * whether it had been saved yet - which is the one thing a preview must not do.
 */

/** A page's declared fields, and the prose below them. */
export interface SplitPage {
  /** As it was written, without the delimiters. Null when the page carries none. */
  frontmatter: string | null;
  body: string;
}

/**
 * Split a page into its frontmatter and the prose below it.
 *
 * Wiki pages carry frontmatter by convention, and rendering it as body text puts a block of
 * `title:` and `tags:` above every page. Only a block opening on the very first line counts,
 * which is what keeps a horizontal rule partway down a page from being read as one.
 */
export function splitFrontmatter(source: string): SplitPage {
  const text = source.startsWith('\ufeff') ? source.slice(1) : source;
  if (!/^---\r?\n/.test(text)) return { frontmatter: null, body: text };

  const end = text.indexOf('\n---', text.indexOf('\n'));
  if (end === -1) return { frontmatter: null, body: text };

  const after = text.indexOf('\n', end + 1);
  if (after === -1) return { frontmatter: text.slice(text.indexOf('\n') + 1, end), body: '' };

  // The blank line conventionally written under the closing delimiter belongs to the block
  // rather than to the prose, so the body begins where the reading does. Exactly one: a
  // page that genuinely opens on blank lines keeps the rest of them.
  const prose = text.slice(after + 1);
  return {
    frontmatter: text.slice(text.indexOf('\n') + 1, end),
    body: prose.startsWith('\r\n') ? prose.slice(2) : prose.startsWith('\n') ? prose.slice(1) : prose,
  };
}
