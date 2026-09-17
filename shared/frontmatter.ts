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
 * The fields a frontmatter block declares, by key.
 *
 * A deliberately small reading of YAML - `key: value` and `- item` lists, which is all the
 * convention uses. Every value is a list, because a key may carry one or many and a caller
 * that had to ask which would be doing this parsing again.
 *
 * Shared because both sides need it and for different reasons: the app shows these fields
 * beside a page, and the sidecar reads them to index a wiki that has no prebuilt index -
 * which is every wiki but the one this was written against.
 */
export function readFields(frontmatter: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let last: string | null = null;

  for (const line of frontmatter.split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && last) {
      fields.get(last)!.push(unquote(item[1]!));
      continue;
    }

    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;

    const [, key, value] = field;
    last = key!;
    const written = unquote(value!);
    fields.set(key!, written ? [written] : []);
  }

  return fields;
}

/** Values are written quoted about as often as not, and the quotes are never the value. */
function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

/** The first value a key carries, for the keys that only ever have one. */
export function firstField(fields: Map<string, string[]>, key: string): string | undefined {
  const value = fields.get(key)?.[0];
  return value ? value : undefined;
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
