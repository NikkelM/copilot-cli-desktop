import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
/** Where the wiki's files really live, which is not where the app looks for them. */
let store: string;

/** paths.ts reads COPILOT_HOME once at import, so the module cache must be cleared. */
async function loadWiki() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./wiki.js');
}

function page(path: string, contents: string): void {
  const file = join(store, ...path.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

const withFrontmatter = (title: string, body = 'Some prose.') =>
  ['---', `title: ${title}`, 'summary: what it is about', '---', '', body].join('\n');

/**
 * The real wiki root is a symlink, which is the whole reason containment is judged on the
 * resolved path. Linked here too, so the tests exercise the same shape.
 */
function linkWiki(): boolean {
  try {
    symlinkSync(store, join(home, 'wiki'), 'junction');
    return true;
  } catch {
    // Windows without developer mode refuses to create links for an unprivileged process.
    return false;
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccd-wiki-home-'));
  store = mkdtempSync(join(tmpdir(), 'ccd-wiki-store-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

describe('listing the pages there are', () => {
  it('finds pages at the root and below it', async () => {
    if (!linkWiki()) return;
    page('index.md', withFrontmatter('Index'));
    page('resources/guides/rtk.md', withFrontmatter('RTK'));
    const { listWikiPages } = await loadWiki();

    const paths = (await listWikiPages()).map((entry) => entry.path);

    expect(paths).toContain('index.md');
    expect(paths).toContain('resources/guides/rtk.md');
  });

  // Spoken with forward slashes whatever the platform uses, so a path means one thing.
  it('speaks paths in one separator', async () => {
    if (!linkWiki()) return;
    page('projects/app/notes.md', withFrontmatter('Notes'));
    const { listWikiPages } = await loadWiki();

    expect((await listWikiPages()).map((entry) => entry.path)).toEqual(['projects/app/notes.md']);
  });

  it('leaves anything that is not a page alone', async () => {
    if (!linkWiki()) return;
    page('index.md', withFrontmatter('Index'));
    page('_manifest.json', '{"pages":[]}');
    page('assets/diagram.png', 'not markdown');
    const { listWikiPages } = await loadWiki();

    expect((await listWikiPages()).map((entry) => entry.path)).toEqual(['index.md']);
  });

  /**
   * The filesystem says what exists and the index only describes it. Trusting the index
   * would hide a page that is on disk, which is the one thing a browser must not do.
   */
  it('lists a page the index has never heard of', async () => {
    if (!linkWiki()) return;
    page('_manifest.json', JSON.stringify({ pages: [{ path: 'old.md', title: 'Old' }] }));
    page('brand-new.md', withFrontmatter('Brand New'));
    const { listWikiPages } = await loadWiki();

    const found = await listWikiPages();
    expect(found.map((entry) => entry.path)).toEqual(['brand-new.md']);
    // Named after its file until the index catches up, rather than left without a name.
    expect(found[0]?.title).toBe('brand-new');
  });

  it('takes the title and summary the index knows', async () => {
    if (!linkWiki()) return;
    page(
      '_manifest.json',
      JSON.stringify({ pages: [{ path: 'resources/tools/rtk.md', title: 'RTK', summary: 'token savings' }] }),
    );
    page('resources/tools/rtk.md', withFrontmatter('RTK'));
    const { listWikiPages } = await loadWiki();

    const found = (await listWikiPages())[0];
    expect(found?.title).toBe('RTK');
    expect(found?.summary).toBe('token savings');
  });

  it('still lists the pages when the index is unreadable', async () => {
    if (!linkWiki()) return;
    page('_manifest.json', 'not json at all');
    page('index.md', withFrontmatter('Index'));
    const { listWikiPages } = await loadWiki();

    expect((await listWikiPages()).map((entry) => entry.path)).toEqual(['index.md']);
  });

  // Most machines have no wiki, which is not a failure.
  it('answers with nothing when there is no wiki', async () => {
    const { listWikiPages } = await loadWiki();

    expect(await listWikiPages()).toEqual([]);
  });
});

/**
 * An empty wiki and a missing one need different sentences: one wants the folder made, the
 * other only wants a page put in it.
 */
describe('saying whether there is a wiki at all', () => {
  it('says there is none when the folder is absent', async () => {
    const { wikiExists } = await loadWiki();

    expect(await wikiExists()).toBe(false);
  });

  it('says there is one when the folder is there but empty', async () => {
    if (!linkWiki()) return;
    const { wikiExists, listWikiPages } = await loadWiki();

    expect(await wikiExists()).toBe(true);
    expect(await listWikiPages()).toEqual([]);
  });

  it('says there is one when it holds pages', async () => {
    if (!linkWiki()) return;
    page('index.md', withFrontmatter('Index'));
    const { wikiExists } = await loadWiki();

    expect(await wikiExists()).toBe(true);
  });
});

describe('reading one page', () => {
  it('hands back the prose without the frontmatter above it', async () => {
    if (!linkWiki()) return;
    page('index.md', withFrontmatter('Index', '# Heading\n\nthe body'));
    const { readWikiPage } = await loadWiki();

    const found = await readWikiPage('index.md');
    expect(found?.body).toBe('# Heading\n\nthe body');
    expect(found?.frontmatter).toContain('title: Index');
  });

  it('reads a page that carries no frontmatter at all', async () => {
    if (!linkWiki()) return;
    page('plain.md', '# Just a heading');
    const { readWikiPage } = await loadWiki();

    const found = await readWikiPage('plain.md');
    expect(found?.body).toBe('# Just a heading');
    expect(found?.frontmatter).toBeUndefined();
  });

  it('says nothing for a page that is not there', async () => {
    if (!linkWiki()) return;
    const { readWikiPage } = await loadWiki();

    expect(await readWikiPage('missing.md')).toBeNull();
  });
});

/**
 * Every read goes through one containment check, on the resolved path rather than on the
 * text - so `..`, an absolute path and a link pointing out of the tree are refused by the
 * same rule rather than by three separate ones.
 */
describe('staying inside the wiki', () => {
  it('refuses a path climbing out of the root', async () => {
    if (!linkWiki()) return;
    writeFileSync(join(home, 'secret.md'), 'not for the browser');
    const { readWikiPage } = await loadWiki();

    expect(await readWikiPage('../secret.md')).toBeNull();
  });

  it('refuses an absolute path', async () => {
    if (!linkWiki()) return;
    writeFileSync(join(home, 'secret.md'), 'not for the browser');
    const { readWikiPage } = await loadWiki();

    expect(await readWikiPage(join(home, 'secret.md'))).toBeNull();
  });

  it('refuses a page that climbs out through several steps', async () => {
    if (!linkWiki()) return;
    page('resources/guides/rtk.md', withFrontmatter('RTK'));
    const { readWikiPage } = await loadWiki();

    expect(await readWikiPage('resources/guides/../../../secret.md')).toBeNull();
  });

  /** The root itself is a link, so a page inside it resolves somewhere else and is fine. */
  it('reads a page through the link the root is', async () => {
    if (!linkWiki()) return;
    page('index.md', withFrontmatter('Index', 'through the link'));
    const { readWikiPage } = await loadWiki();

    expect((await readWikiPage('index.md'))?.body).toBe('through the link');
  });

  // A link inside the wiki pointing out of it is the case the text of a path cannot catch.
  it('refuses a page that is itself a link out of the tree', async () => {
    if (!linkWiki()) return;
    const outside = join(home, 'outside.md');
    writeFileSync(outside, 'not for the browser');
    try {
      symlinkSync(outside, join(store, 'escape.md'), 'file');
    } catch {
      return;
    }
    const { readWikiPage } = await loadWiki();

    expect(await readWikiPage('escape.md')).toBeNull();
  });
});

describe('separating frontmatter from prose', () => {
  it('takes a block that opens the page', async () => {
    const { splitFrontmatter } = await loadWiki();

    expect(splitFrontmatter('---\ntitle: A\n---\nbody')).toEqual({ frontmatter: 'title: A', body: 'body' });
  });

  /** The blank under the closing delimiter is the block's own formatting, not the prose. */
  it('begins the body where the reading begins', async () => {
    const { splitFrontmatter } = await loadWiki();

    expect(splitFrontmatter('---\ntitle: A\n---\n\n# Heading').body).toBe('# Heading');
  });

  it('keeps blank lines a page genuinely opens with', async () => {
    const { splitFrontmatter } = await loadWiki();

    expect(splitFrontmatter('---\ntitle: A\n---\n\n\n\n# Heading').body).toBe('\n\n# Heading');
  });

  /** A rule partway down a page is prose, and reading it as frontmatter would eat the page. */
  it('leaves a rule further down the page alone', async () => {
    const { splitFrontmatter } = await loadWiki();
    const source = '# Heading\n\n---\n\nmore prose';

    expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
  });

  it('leaves a page whose block never closes alone', async () => {
    const { splitFrontmatter } = await loadWiki();
    const source = '---\ntitle: A\n\nbody that never closes it';

    expect(splitFrontmatter(source)).toEqual({ frontmatter: null, body: source });
  });

  it('reads a block written with carriage returns', async () => {
    const { splitFrontmatter } = await loadWiki();

    expect(splitFrontmatter('---\r\ntitle: A\r\n---\r\nbody').body).toBe('body');
  });
});

/**
 * Writing a page back, which is what makes the browser an editor. The same containment rule
 * as reading, on the resolved real path.
 */
describe('writing a page back', () => {
  it('writes what it was given, exactly', async () => {
    if (!linkWiki()) return;
    page('index.md', withFrontmatter('Index'));
    const { writeWikiPage, readWikiPage } = await loadWiki();

    const written = await writeWikiPage('index.md', '---\ntitle: Edited\n---\n\nnew prose');

    expect(written).toBe(true);
    expect((await readWikiPage('index.md'))?.source).toBe('---\ntitle: Edited\n---\n\nnew prose');
  });

  it('hands the whole file back beside the split of it', async () => {
    if (!linkWiki()) return;
    page('index.md', '---\ntitle: Index\n---\n\n\n\nspaced out\n\n');
    const { readWikiPage } = await loadWiki();

    const found = await readWikiPage('index.md');
    expect(found?.source).toBe('---\ntitle: Index\n---\n\n\n\nspaced out\n\n');
    expect(found?.body).toBe('\n\nspaced out\n\n');
  });

  it('refuses a page outside the wiki', async () => {
    if (!linkWiki()) return;
    const outside = join(home, 'secret.md');
    writeFileSync(outside, 'untouched');
    const { writeWikiPage } = await loadWiki();

    expect(await writeWikiPage('../secret.md', 'overwritten')).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
  });

  /**
   * Containment is judged by resolving the real path, which a file that does not exist has
   * none of - so creating pages needs a rule of its own rather than falling out of this one.
   */
  it('refuses a page that is not already there', async () => {
    if (!linkWiki()) return;
    const { writeWikiPage } = await loadWiki();

    expect(await writeWikiPage('brand-new.md', 'hello')).toBe(false);
  });

  it('says so when there is no wiki to write into', async () => {
    const { writeWikiPage } = await loadWiki();

    expect(await writeWikiPage('index.md', 'hello')).toBe(false);
  });
});

