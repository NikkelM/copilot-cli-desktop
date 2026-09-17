import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { copilotHome } from './paths.js';
import type { WikiPage, WikiPageContent } from '../../shared/protocol.js';

/** The knowledge base this app can browse, beside the CLI's own state. */
export const wikiDir = join(copilotHome, 'wiki');

/** The prebuilt search index, which also carries every page's title and summary. */
const manifestFile = join(wikiDir, '_manifest.json');

/** Directories that hold the wiki's machinery rather than its pages. */
const SKIPPED = new Set(['.obsidian', '.git', 'assets', '_templates']);

/**
 * The wiki root as the filesystem knows it.
 *
 * Resolved rather than used as written, because the root is a symlink here. Containment has
 * to be judged against the real location or a path could leave the wiki while still looking
 * as though it were inside it.
 *
 * Resolved on each call rather than remembered: the link can be repointed while the app is
 * open, and the cost is one syscall against a read that is about to touch the disk anyway.
 */
async function realRoot(): Promise<string | null> {
  try {
    return await realpath(wikiDir);
  } catch {
    // No wiki on this machine, which is not an error - most machines will not have one.
    return null;
  }
}

/**
 * Whether there is a wiki here at all.
 *
 * Told apart from an empty one on purpose: a machine with no wiki needs to be told what one
 * is and where to put it, while a wiki with nothing in it needs neither.
 */
export async function wikiExists(): Promise<boolean> {
  return (await realRoot()) !== null;
}

/**
 * The absolute path a page argument names, or null when it names somewhere else entirely.
 *
 * Every read goes through here, and the check is on the resolved real path rather than on
 * the text - so `..` segments, an absolute path, and a page that is itself a link pointing
 * out of the tree are all refused by one rule rather than by three that could disagree.
 * Checking the text as well was tried and removed: it could not refuse anything this does
 * not, and a rule no test can distinguish is a rule nobody can rely on.
 *
 * A page that does not exist resolves to nothing and is refused the same way, which is the
 * right answer to give a link that has gone stale.
 */
export async function resolveWikiPath(page: string): Promise<string | null> {
  const root = await realRoot();
  if (!root) return null;

  try {
    const real = await realpath(resolve(root, page));
    return real === root || real.startsWith(root + sep) ? real : null;
  } catch {
    return null;
  }
}

/** Paths are spoken in the protocol with forward slashes, whatever the platform uses. */
function asPagePath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

interface ManifestEntry {
  path?: unknown;
  title?: unknown;
  summary?: unknown;
  category?: unknown;
  updated?: unknown;
  tags?: unknown;
}

/** What the manifest knows about each page, by path, or an empty map when there is none. */
async function manifest(): Promise<Map<string, ManifestEntry>> {
  const known = new Map<string, ManifestEntry>();

  try {
    const parsed = JSON.parse(await readFile(manifestFile, 'utf8')) as { pages?: unknown };
    const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
    for (const entry of pages as ManifestEntry[]) {
      if (typeof entry?.path === 'string') known.set(entry.path.split(sep).join('/'), entry);
    }
  } catch {
    // A missing or half-written manifest costs titles, not pages: the tree is read from
    // the filesystem, which is the thing that says what is actually there.
  }

  return known;
}

/** Every markdown file below a directory, depth first, in the order a reader would expect. */
async function walk(root: string, directory: string, found: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.obsidian') continue;
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (SKIPPED.has(entry.name)) continue;
      await walk(root, full, found);
    } else if (entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
}

/**
 * Every page there is, with whatever the manifest can say about each.
 *
 * The filesystem decides what exists and the manifest only describes it, so a page written
 * since the index was last built is still listed - under its filename until the index
 * catches up. The alternative, trusting the manifest, would hide a page that is on disk,
 * which is the one thing a browser must not do.
 *
 * Costs a directory walk and one JSON read. No Copilot process, like everything else that
 * only reads.
 */
export async function listWikiPages(): Promise<WikiPage[]> {
  const root = await realRoot();
  if (!root) return [];

  const files: string[] = [];
  try {
    await walk(root, root, files);
  } catch {
    return [];
  }

  const known = await manifest();
  return files.map((file) => {
    const path = asPagePath(root, file);
    const entry = known.get(path);
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

    return {
      path,
      title: text(entry?.title) ?? path.split('/').pop()!.replace(/\.md$/, ''),
      ...(text(entry?.summary) ? { summary: text(entry?.summary)! } : {}),
      ...(text(entry?.category) ? { category: text(entry?.category)! } : {}),
      ...(text(entry?.updated) ? { updated: text(entry?.updated)! } : {}),
      ...(Array.isArray(entry?.tags) ? { tags: entry.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
    };
  });
}

/**
 * Split a page into its frontmatter and the prose below it.
 *
 * Wiki pages carry frontmatter by convention, and rendering it as body text puts a block of
 * `title:` and `tags:` above every page. Only a block opening on the very first line counts,
 * which is what keeps a horizontal rule partway down a page from being read as one.
 */
export function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
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

/**
 * One page, as it is on disk.
 *
 * The frontmatter is handed over as it was written rather than parsed here: what the fields
 * mean is the reader's business, and a page whose frontmatter this cannot make sense of
 * should still be readable.
 */
export async function readWikiPage(page: string): Promise<WikiPageContent | null> {
  const root = await realRoot();
  const file = await resolveWikiPath(page);
  if (!root || !file) return null;

  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    return null;
  }

  const { frontmatter, body } = splitFrontmatter(source);
  return {
    path: asPagePath(root, file),
    ...(frontmatter === null ? {} : { frontmatter }),
    body,
  };
}
