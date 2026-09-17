import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { splitFrontmatter } from '../../shared/frontmatter.js';

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
  // Whole, frontmatter and all: what a page renders to is the app's question, not this one.
  it('hands back the file as it is written', async () => {
    if (!linkWiki()) return;
    page('index.md', withFrontmatter('Index', '# Heading\n\nthe body'));
    const { readWikiPage } = await loadWiki();

    const found = await readWikiPage('index.md');
    expect(found?.source).toBe(withFrontmatter('Index', '# Heading\n\nthe body'));
  });

  it('reads a page that carries no frontmatter at all', async () => {
    if (!linkWiki()) return;
    page('plain.md', '# Just a heading');
    const { readWikiPage } = await loadWiki();

    const found = await readWikiPage('plain.md');
    expect(found?.source).toBe('# Just a heading');
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

    expect((await readWikiPage('index.md'))?.source).toContain('through the link');
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

  it('hands the file back exactly as it is written', async () => {
    if (!linkWiki()) return;
    page('index.md', '---\ntitle: Index\n---\n\n\n\nspaced out\n\n');
    const { readWikiPage } = await loadWiki();

    // Every blank line kept, so saving cannot reformat what it was never asked to touch.
    const found = await readWikiPage('index.md');
    expect(found?.source).toBe('---\ntitle: Index\n---\n\n\n\nspaced out\n\n');
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


/**
 * Starting one, which is what the onboarding button does. It must never be the thing that
 * overwrote something, because it is offered whenever the wiki is empty.
 */
describe('starting a knowledge base', () => {
  it('makes the folder and writes a first page', async () => {
    process.env.COPILOT_WIKI_DIR = join(store, 'fresh');
    const { createWiki, listWikiPages, readWikiPage } = await loadWiki();

    const made = await createWiki();

    expect(made).toBe('Home.md');
    expect((await listWikiPages()).map((entry) => entry.path)).toEqual(['Home.md']);
    expect((await readWikiPage('Home.md'))?.source).toContain('# Home');
    delete process.env.COPILOT_WIKI_DIR;
  });

  /** The page it writes has to be readable by the browser that is about to open it. */
  it('writes a page the browser can make sense of', async () => {
    process.env.COPILOT_WIKI_DIR = join(store, 'fresh');
    const { createWiki, readWikiPage } = await loadWiki();
    await createWiki();

    const { frontmatter, body } = splitFrontmatter((await readWikiPage('Home.md'))!.source);
    expect(frontmatter).toContain('title: Home');
    expect(body.startsWith('# Home')).toBe(true);
    delete process.env.COPILOT_WIKI_DIR;
  });

  it('writes a first page into a folder that is already there', async () => {
    if (!linkWiki()) return;
    const { createWiki, listWikiPages } = await loadWiki();

    const made = await createWiki();

    expect(made).toBe('Home.md');
    expect((await listWikiPages()).map((entry) => entry.path)).toEqual(['Home.md']);
  });

  // Offered whenever the wiki is empty, so it has to be harmless when it is not.
  it('touches nothing when there are already pages', async () => {
    if (!linkWiki()) return;
    page('index.md', withFrontmatter('Index', 'the original'));
    const { createWiki, readWikiPage } = await loadWiki();

    const made = await createWiki();

    expect(made).toBe('index.md');
    expect((await readWikiPage('index.md'))?.source).toContain('the original');
  });

  it('says so when the folder cannot be made', async () => {
    // A file where the folder should go, so creating a directory there cannot work.
    const blocked = join(store, 'blocked');
    writeFileSync(blocked, 'not a directory');
    process.env.COPILOT_WIKI_DIR = blocked;
    const { createWiki } = await loadWiki();

    expect(await createWiki()).toBeNull();
    delete process.env.COPILOT_WIKI_DIR;
  });
});

