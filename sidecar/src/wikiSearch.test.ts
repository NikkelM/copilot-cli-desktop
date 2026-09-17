import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { excerptAround, scorePage, searchWiki, termsOf, type IndexedPage } from './wikiSearch.js';

let root: string;

function page(path: string, contents: string): void {
  const file = join(root, ...path.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccd-search-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the terms a query asks about', () => {
  it('splits on whitespace and lowercases', () => {
    expect(termsOf('Hades Dialogue')).toEqual(['hades', 'dialogue']);
  });

  /** One letter matches most of the wiki, so it ranks nothing rather than everything. */
  it('drops a term too short to mean anything', () => {
    expect(termsOf('a hades')).toEqual(['hades']);
  });

  it('asks nothing of an empty query', () => {
    expect(termsOf('   ')).toEqual([]);
  });
});

/**
 * The weights are `Search-Wiki.ps1`'s. The same question asked from the app and from a
 * terminal should not answer differently, and that script is what its reader already knows.
 */
describe('scoring a page the way the wiki script scores it', () => {
  const plain: IndexedPage = { path: 'a.md', title: 'Untitled' };

  it('weights a keyword above a title', () => {
    const keyword = scorePage({ ...plain, keywords: ['hades'] }, '', ['hades']);
    const title = scorePage({ ...plain, title: 'Hades' }, '', ['hades']);

    expect(keyword.score).toBe(10);
    expect(title.score).toBe(8);
  });

  it('weights a heading above a summary, and a summary above a tag', () => {
    expect(scorePage({ ...plain, headings: ['Hades'] }, '', ['hades']).score).toBe(5);
    expect(scorePage({ ...plain, summary: 'about hades' }, '', ['hades']).score).toBe(4);
    expect(scorePage({ ...plain, tags: ['hades'] }, '', ['hades']).score).toBe(3);
  });

  it('adds every field a term appears in', () => {
    const found = scorePage({ ...plain, title: 'Hades', tags: ['hades'] }, 'hades', ['hades']);

    expect(found.score).toBe(8 + 3 + 1);
    expect(found.matched.sort()).toEqual(['content', 'tags', 'title']);
  });

  /** In the prose repetition is the only signal there is, so it counts - up to a point. */
  it('counts repetition in the prose', () => {
    expect(scorePage(plain, 'hades hades hades', ['hades']).score).toBe(3);
  });

  it('caps what the prose alone can be worth', () => {
    expect(scorePage(plain, 'hades '.repeat(50), ['hades']).score).toBe(5);
  });

  /**
   * A page answering every word of a question is worth more than one answering a single word
   * very loudly, which the per-field weights alone do not say.
   */
  it('rewards a page that answers more of the question', () => {
    const both = scorePage({ ...plain, title: 'Hades dialogue' }, '', ['hades', 'dialogue']);

    // Eight for each term in the title, plus two for the second term matching at all.
    expect(both.score).toBe(8 + 8 + 2);
  });

  it('scores nothing for a page the terms do not reach', () => {
    expect(scorePage(plain, 'something else entirely', ['hades']).score).toBe(0);
  });

  it('matches part of a word, as the script does', () => {
    expect(scorePage({ ...plain, keywords: ['wikilinks'] }, '', ['wiki']).score).toBe(10);
  });
});

describe('the prose around a match', () => {
  it('takes the text around the first term to appear', () => {
    const found = excerptAround('a long way before, then hades appears here', ['hades']);

    expect(found).toContain('hades appears here');
  });

  /**
   * A page's title and keywords live in its frontmatter, so a term that put the page at the
   * top of the results is usually in there - and drawing the excerpt from the whole file
   * showed `--- title: … category: …` instead of anything the page says.
   */
  it('skips the frontmatter, where the title and keywords live', () => {
    const source = [
      '---',
      'title: HadesDialogueExplorer',
      'category: reference',
      'keywords:',
      '  - hades',
      '---',
      '',
      'An interactive explorer for hades dialogue.',
    ].join('\n');

    const found = excerptAround(source, ['hades']);

    expect(found).toBe('An interactive explorer for hades dialogue.');
    expect(found).not.toContain('title:');
  });

  /** Nothing in the prose is a real answer, and the caller says where it matched instead. */
  it('says nothing for a term that only appears in the frontmatter', () => {
    const source = '---\ntitle: Hades\n---\n\nnothing relevant below';

    expect(excerptAround(source, ['hades'])).toBeNull();
  });

  it('marks where it was cut', () => {
    const body = `${'x'.repeat(400)} hades ${'y'.repeat(400)}`;

    expect(excerptAround(body, ['hades'])).toMatch(/^….*…$/);
  });

  it('collapses the whitespace of a page written in paragraphs', () => {
    expect(excerptAround('before\n\n  hades  \n\nafter', ['hades'])).not.toContain('\n');
  });

  it('says nothing for a page the terms do not appear in', () => {
    expect(excerptAround('nothing to see', ['hades'])).toBeNull();
  });
});

describe('answering a query from the pages there are', () => {
  const pages: IndexedPage[] = [
    { path: 'about.md', title: 'About Hades', keywords: ['hades'] },
    { path: 'mentions.md', title: 'Something else' },
    { path: 'unrelated.md', title: 'Nothing here' },
  ];

  beforeEach(() => {
    page('about.md', 'a page about the game');
    page('mentions.md', 'this one merely mentions hades once');
    page('unrelated.md', 'nothing relevant at all');
  });

  it('ranks the page a term is about above one that mentions it', async () => {
    const found = await searchWiki(root, pages, 'hades', 10);

    expect(found.map((result) => result.path)).toEqual(['about.md', 'mentions.md']);
  });

  it('leaves out the pages nothing matched', async () => {
    const found = await searchWiki(root, pages, 'hades', 10);

    expect(found.map((result) => result.path)).not.toContain('unrelated.md');
  });

  it('says where each result matched', async () => {
    const found = await searchWiki(root, pages, 'hades', 10);

    expect(found[0]?.matchedIn).toContain('keywords');
    expect(found[1]?.matchedIn).toEqual(['content']);
  });

  it('carries the prose around the match', async () => {
    const found = await searchWiki(root, pages, 'hades', 10);

    expect(found.find((result) => result.path === 'mentions.md')?.excerpt).toContain('mentions hades');
  });

  it('takes only as many as it was asked for', async () => {
    expect(await searchWiki(root, pages, 'hades', 1)).toHaveLength(1);
  });

  it('answers nothing to a query with no usable terms', async () => {
    expect(await searchWiki(root, pages, 'a', 10)).toEqual([]);
  });

  /** Equal scores must come back in the same order every time, not the filesystem's. */
  it('breaks a tie by path', async () => {
    page('b.md', 'hades');
    page('a.md', 'hades');
    const tied: IndexedPage[] = [
      { path: 'b.md', title: 'B' },
      { path: 'a.md', title: 'A' },
    ];

    expect((await searchWiki(root, tied, 'hades', 10)).map((result) => result.path)).toEqual(['a.md', 'b.md']);
  });

  // Listed but unreadable, which its metadata can still answer for.
  it('still ranks a page whose file has gone', async () => {
    const missing: IndexedPage[] = [{ path: 'gone.md', title: 'Hades', keywords: ['hades'] }];

    const found = await searchWiki(root, missing, 'hades', 10);
    expect(found).toHaveLength(1);
    expect(found[0]?.excerpt).toBeUndefined();
  });
});
