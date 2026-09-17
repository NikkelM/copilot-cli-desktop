import type { WikiPage } from '../../shared/protocol';

/**
 * Where a link inside a wiki page leads, if it leads anywhere in the wiki.
 *
 * Pages link to each other two ways. Obsidian wikilinks dominate - 320 of them against 65
 * relative markdown links in the wiki this was written for - and neither form names a page
 * the way the protocol does, so both have to be resolved against the pages that exist
 * rather than trusted as written.
 */

/** A link target as a page path and the place in it, if one was named. */
export interface WikiTarget {
  path: string;
  /** The heading the link pointed at, without its hash. */
  hash?: string;
}

/** Split a trailing `#heading` off a link, which either form may carry. */
function splitHash(link: string): { target: string; hash?: string } {
  const hash = link.indexOf('#');
  if (hash === -1) return { target: link };
  return { target: link.slice(0, hash), ...(hash < link.length - 1 ? { hash: link.slice(hash + 1) } : {}) };
}

/** Normalise a path for comparison: forward slashes, no leading `./`, no `.md`. */
function normalise(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.md$/i, '')
    .toLowerCase();
}

/** Resolve a relative path against the directory a page sits in. */
function against(from: string, link: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const step of link.split('/')) {
    if (step === '' || step === '.') continue;
    if (step === '..') parts.pop();
    else parts.push(step);
  }
  return parts.join('/');
}

/**
 * The page a link names, or null when nothing in the wiki answers to it.
 *
 * Resolved against the pages that exist rather than by building a path, because a wikilink
 * may name a page by its bare title from anywhere in the tree - `[[Home]]` from three
 * directories down means the same page it does from the root. A path is tried first, so a
 * link that names one exactly is never captured by a page that merely shares its name.
 */
export function resolveWikiLink(link: string, from: string, pages: WikiPage[]): WikiTarget | null {
  const { target, hash } = splitHash(link.trim());
  // A link that is only a hash is a place in the page already open.
  if (!target) return hash ? { path: from, hash } : null;

  const wanted = normalise(target);
  const relative = normalise(against(from, target));

  const exact = pages.find((page) => normalise(page.path) === relative || normalise(page.path) === wanted);
  if (exact) return { path: exact.path, ...(hash ? { hash } : {}) };

  // Named by its own filename, which is how a wikilink usually names a page.
  const byName = pages.find((page) => normalise(page.path.split('/').pop()!) === wanted);
  if (byName) return { path: byName.path, ...(hash ? { hash } : {}) };

  // Written as a title rather than as a filename, which Obsidian also accepts.
  const byTitle = pages.find((page) => page.title.toLowerCase() === target.trim().toLowerCase());
  return byTitle ? { path: byTitle.path, ...(hash ? { hash } : {}) } : null;
}

/**
 * Rewrite Obsidian wikilinks as ordinary markdown links.
 *
 * The renderer has never heard of `[[page|label]]`, and showing the brackets as text would
 * leave a third of this wiki's cross-references unreadable. Rewritten to the form the
 * renderer already handles, which means one link handler rather than two.
 *
 * A link that resolves to nothing is left as written. It is a broken link either way, and
 * drawing it as a link that goes nowhere would be worse than showing what the page says.
 */
export function withResolvedLinks(body: string, from: string, pages: WikiPage[]): string {
  return body.replace(/\[\[([^\]\n]+)\]\]/g, (whole, inside: string) => {
    // A link written inside a table escapes its own separator, because a bare pipe would
    // split the cell. 15 of this wiki's 315 links are written that way.
    const [rawLink, label] = inside.split('|');
    const link = (rawLink ?? '').replace(/\\$/, '');
    const found = resolveWikiLink(link, from, pages);
    if (!found) return whole;

    const text = (label ?? link).trim();
    const href = found.hash ? `${found.path}#${found.hash}` : found.path;
    // Escaped, so a bracket in a label cannot open a second link and take the rest of the line.
    return `[${text.replace(/[[\]]/g, '\\$&')}](${encodeURI(href)})`;
  });
}

/** Whether a link is one this app should follow itself rather than hand to the system. */
export function isWikiLink(href: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#');
}
