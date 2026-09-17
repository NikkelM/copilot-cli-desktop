import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { copilotHome } from './paths.js';
import type { WikiPage, WikiPageContent } from '../../shared/protocol.js';

/**
 * The knowledge base this app can browse.
 *
 * Beside the CLI's own state by default, and overridable, because where someone keeps their
 * notes is their business - a folder already synced or already open in an editor is a
 * better answer than a second copy under this app's directory.
 */
export const wikiDir = process.env.COPILOT_WIKI_DIR ?? join(copilotHome, 'wiki');

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
 * What a wiki starts as.
 *
 * A page rather than an empty folder, because an empty folder is the same dead end one step
 * further on: it would say "no pages here yet" and still leave the reader to work out how to
 * make one. This is also a demonstration of the two conventions worth knowing - frontmatter,
 * and that the prose is ordinary markdown - in the one place they are certain to be read.
 */
const FIRST_PAGE = `---
title: Home
summary: The first page of this knowledge base
---

# Home

This is a knowledge base: a folder of markdown files, browsable from the app.

Press **Raw** above to edit this page, and Ctrl+S to save it. Everything here is an
ordinary file, so an editor, a script or an agent can write pages too.

## How it is put together

- Sub-folders become the tree on the left, so arrange them however suits you
- \`title\` and \`summary\` in the frontmatter name a page; without them it is named
  after its file
- Pages link to each other as \`[[wikilinks]]\` or as ordinary markdown links
- A page called \`index.md\`, \`Home.md\` or \`README.md\` opens first

## What to keep here

Things worth knowing again: what a system does and why, a decision and what it turned on,
a procedure that took an afternoon to work out the first time.
`;

/**
 * Start a knowledge base where one was expected.
 *
 * Makes the folder if it is missing and writes a first page if there is none. Refuses to
 * touch a page that is already there, so this can be offered whenever the wiki is empty
 * without it ever being the thing that overwrote something.
 *
 * Returns the page to open, or null when nothing could be made.
 */
export async function createWiki(): Promise<string | null> {
  try {
    await mkdir(wikiDir, { recursive: true });
  } catch {
    return null;
  }

  const existing = await listWikiPages();
  if (existing.length > 0) return existing[0]!.path;

  const root = await realRoot();
  if (!root) return null;

  try {
    /**
     * Exclusive, so a page written between the listing above and this line survives.
     *
     * Unlike the containment check, which was removed for being a rule no test could tell
     * apart from its absence, this one is not redundant - it is simply the only part of
     * this function a test cannot reach, because reaching it means interleaving two writers.
     * Untestable and pointless are different things.
     */
    await writeFile(join(root, 'Home.md'), FIRST_PAGE, { encoding: 'utf8', flag: 'wx' });
  } catch {
    return null;
  }

  return 'Home.md';
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
 *
 * The whole file comes too. The split is what gets rendered, but an editor has to hand back
 * exactly what it was given or saving would rewrite formatting nobody asked it to touch.
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
    source,
  };
}

/**
 * Write a page back, as it was edited.
 *
 * Only over a page that is already there. Containment is judged by resolving the real path,
 * which a file that does not exist has none of - so creating pages would need a different
 * rule, and inventing one silently while implementing editing would be the wrong moment to
 * decide it.
 *
 * Written whole rather than patched: the editor holds the file, not a view of it.
 */
export async function writeWikiPage(page: string, source: string): Promise<boolean> {
  const file = await resolveWikiPath(page);
  if (!file) return false;

  try {
    await writeFile(file, source, 'utf8');
    return true;
  } catch {
    // A read-only file or a folder that has gone. The caller says so rather than pretending.
    return false;
  }
}




