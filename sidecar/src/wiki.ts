import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { copilotHome } from './paths.js';
import { searchWiki, type IndexedPage } from './wikiSearch.js';
import { firstField, readFields, splitFrontmatter } from '../../shared/frontmatter.js';
import type { WikiPage, WikiPageContent, WikiSearchResult } from '../../shared/protocol.js';

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

This is a knowledge base: a folder of markdown files, browsable from the app. Press **Raw**
above to edit this page, and Ctrl+S to save it.

## How it is put together

- Sub-folders become the tree on the left, so arrange them however suits you
- \`title\` and \`summary\` in the frontmatter name a page; without them it is named
  after its file
- Pages link to each other as \`[[wikilinks]]\` or as ordinary markdown links
- A page called \`index.md\`, \`Home.md\` or \`README.md\` opens first

Everything here is an ordinary file, so an editor, a script or an agent can write pages too.
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
 * Answer a query from the pages that can be ranked.
 *
 * Where an index exists it is what gets searched - which is the opposite rule to the tree's,
 * and deliberate. The index is curated: it leaves out README files, artifacts, date-stamped
 * output and anything marked `indexed: false`, and a page under `projects/` joins it by
 * declaring `indexed: true`. Browsing should show everything that exists; ranking should
 * respect what its owner decided is worth finding. The consequence is that a page written
 * since the index was last built is browsable but not findable, exactly as from the terminal.
 *
 * Where no index exists - which is every wiki but the one this was written against - the
 * pages themselves are searched, ranked on what their own frontmatter declares. Without this
 * the search box answered nothing at all to anyone who had never run the indexing script, and
 * did it silently.
 */
export async function searchWikiPages(query: string, limit: number): Promise<WikiSearchResult[]> {
  const root = await realRoot();
  if (!root) return [];

  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : undefined;
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

  const known = await manifest();
  const indexed: IndexedPage[] = [];

  if (known.size > 0) {
    for (const [path, entry] of known) {
      indexed.push({
        path,
        title: text(entry.title) ?? path.split('/').pop()!.replace(/\.md$/, ''),
        ...(text(entry.summary) ? { summary: text(entry.summary)! } : {}),
        // Empty rather than absent, so what the index says is taken as said. A page it
        // describes without keywords has none, and must not have any invented for it.
        keywords: strings(entry.keywords) ?? [],
        headings: strings(entry.headings) ?? [],
        tags: strings(entry.tags) ?? [],
      });
    }
  } else {
    // No index: the page list already carries what each page declares, and the headings are
    // derived from the text while it is being read to be searched.
    for (const page of await listWikiPages()) {
      indexed.push({
        path: page.path,
        title: page.title,
        ...(page.summary ? { summary: page.summary } : {}),
        ...(page.tags ? { tags: page.tags } : {}),
      });
    }
  }

  return searchWiki(root, indexed, query, limit);
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
  keywords?: unknown;
  headings?: unknown;
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
 * What a page says about itself, for the pages an index does not describe.
 *
 * Every wiki but the one this was written against has no prebuilt index, and a page named
 * after its file when it plainly declares a title is the browser failing at the first thing
 * it does. Reading a page costs about a fifth of a millisecond here; doing it only for the
 * pages the index misses means a curated wiki pays nothing.
 *
 * The first heading counts as a title too. Notes kept as plain markdown carry no frontmatter
 * at all - the category READMEs in this very wiki are that shape - and naming such a page
 * after its file when its own first line says `# Projects` helps nobody.
 */
async function describedBy(file: string): Promise<{ fields: Map<string, string[]>; heading?: string }> {
  try {
    const { frontmatter, body } = splitFrontmatter(await readFile(file, 'utf8'));
    const heading = /^\s{0,3}#\s+(.+)$/m.exec(body)?.[1]?.trim();

    return {
      fields: frontmatter ? readFields(frontmatter) : new Map(),
      ...(heading ? { heading } : {}),
    };
  } catch {
    return { fields: new Map() };
  }
}

/**
 * Every page there is, with whatever can be said about each.
 *
 * The filesystem decides what exists and the index only describes it, so a page written since
 * the index was last built is still listed. Where the index has nothing to say - because the
 * page is new, or excluded from it, or because there is no index at all - the page's own
 * frontmatter is read instead.
 *
 * Costs a directory walk, one JSON read, and a read of each page the index misses. No Copilot
 * process, like everything else that only reads.
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
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

  return Promise.all(
    files.map(async (file): Promise<WikiPage> => {
      const path = asPagePath(root, file);
      const entry = known.get(path);
      const described = entry ? { fields: new Map<string, string[]>() } : await describedBy(file);
      const declared = described.fields;

      const title =
        text(entry?.title) ??
        firstField(declared, 'title') ??
        described.heading ??
        path.split('/').pop()!.replace(/\.md$/, '');
      const summary = text(entry?.summary) ?? firstField(declared, 'summary');
      const category = text(entry?.category) ?? firstField(declared, 'category');
      const updated = text(entry?.updated) ?? firstField(declared, 'updated');
      const tags = Array.isArray(entry?.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
        : declared.get('tags');

      return {
        path,
        title,
        ...(summary ? { summary } : {}),
        ...(category ? { category } : {}),
        ...(updated ? { updated } : {}),
        ...(tags?.length ? { tags } : {}),
      };
    }),
  );
}

/**
 * One page, as it is on disk.
 *
 * Handed over whole rather than split. What a page renders to is the app's question, and it
 * has to split a page being edited anyway - so splitting here as well would mean two
 * implementations that could disagree, and the same file sent three times.
 */
export async function readWikiPage(page: string): Promise<WikiPageContent | null> {
  const root = await realRoot();
  const file = await resolveWikiPath(page);
  if (!root || !file) return null;

  try {
    return { path: asPagePath(root, file), source: await readFile(file, 'utf8') };
  } catch {
    return null;
  }
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








