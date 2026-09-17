import { describe, expect, it } from 'vitest';

import { isWikiLink, landingPage, resolveWikiLink, withResolvedLinks } from './wikiLinks';
import type { WikiPage } from '../../shared/protocol';

const pages: WikiPage[] = [
  { path: 'Home.md', title: 'Knowledge Base Home' },
  { path: 'index.md', title: 'Index' },
  { path: 'projects/README.md', title: 'Projects' },
  { path: 'projects/copilot-cli-desktop/performance.md', title: 'Performance findings' },
  { path: 'projects/copilot-cli-desktop/overview.md', title: 'Copilot CLI Desktop' },
  { path: 'resources/guides/rtk-install.md', title: 'RTK Install' },
];

describe('finding the page a link names', () => {
  /** How a wikilink usually names a page: by filename, from wherever the reader is. */
  it('finds a page named by its filename from anywhere in the tree', () => {
    expect(resolveWikiLink('Home', 'resources/guides/rtk-install.md', pages)).toEqual({ path: 'Home.md' });
  });

  it('finds a page named by its full path', () => {
    expect(resolveWikiLink('projects/README', 'Home.md', pages)).toEqual({ path: 'projects/README.md' });
  });

  it('finds a page named with its extension', () => {
    expect(resolveWikiLink('index.md', 'Home.md', pages)).toEqual({ path: 'index.md' });
  });

  it('follows a relative link from the page it is written in', () => {
    const found = resolveWikiLink('./overview.md', 'projects/copilot-cli-desktop/performance.md', pages);

    expect(found).toEqual({ path: 'projects/copilot-cli-desktop/overview.md' });
  });

  it('climbs out of a directory', () => {
    const found = resolveWikiLink('../README.md', 'projects/copilot-cli-desktop/performance.md', pages);

    expect(found).toEqual({ path: 'projects/README.md' });
  });

  it('finds a page written as its title', () => {
    expect(resolveWikiLink('Performance findings', 'Home.md', pages)?.path).toBe(
      'projects/copilot-cli-desktop/performance.md',
    );
  });

  it('carries the heading a link pointed at', () => {
    expect(resolveWikiLink('Home#PARA structure', 'index.md', pages)).toEqual({
      path: 'Home.md',
      hash: 'PARA structure',
    });
  });

  /** A link that is only a hash is a place in the page already open. */
  it('reads a bare hash as somewhere in this page', () => {
    expect(resolveWikiLink('#a heading', 'index.md', pages)).toEqual({ path: 'index.md', hash: 'a heading' });
  });

  it('says nothing for a page that is not there', () => {
    expect(resolveWikiLink('never-written', 'index.md', pages)).toBeNull();
  });

  /**
   * A relative path that exists must never be captured by a page that merely shares its
   * name, so the exact match is tried before the search by filename.
   */
  it('prefers the page a path names exactly', () => {
    const ambiguous: WikiPage[] = [
      { path: 'areas/notes.md', title: 'Area notes' },
      { path: 'projects/notes.md', title: 'Project notes' },
    ];

    expect(resolveWikiLink('./notes.md', 'projects/other.md', ambiguous)?.path).toBe('projects/notes.md');
  });
});

describe('rewriting the links a page carries', () => {
  it('turns a wikilink into a link the renderer understands', () => {
    expect(withResolvedLinks('see [[Home]] for more', 'index.md', pages)).toBe('see [Home](Home.md) for more');
  });

  it('keeps the label a wikilink was given', () => {
    const rewritten = withResolvedLinks('see [[projects/README|Projects]]', 'index.md', pages);

    expect(rewritten).toBe('see [Projects](projects/README.md)');
  });

  it('carries a heading through', () => {
    const rewritten = withResolvedLinks('see [[Home#PARA structure]]', 'index.md', pages);

    expect(rewritten).toBe('see [Home#PARA structure](Home.md#PARA%20structure)');
  });

  /**
   * A link inside a table escapes its own separator, because a bare pipe would split the
   * cell. Fifteen of the real wiki's three hundred and fifteen links are written that way,
   * and all fifteen resolved to nothing until this was handled.
   */
  it('reads a link whose separator is escaped for a table', () => {
    const rewritten = withResolvedLinks('| [[projects/README\\|Projects]] |', 'index.md', pages);

    expect(rewritten).toBe('| [Projects](projects/README.md) |');
  });

  /** Broken either way, and a link that goes nowhere is worse than the text as written. */
  it('leaves a link to nothing as it was written', () => {
    expect(withResolvedLinks('see [[never-written]]', 'index.md', pages)).toBe('see [[never-written]]');
  });

  it('rewrites every link in a page', () => {
    const rewritten = withResolvedLinks('[[Home]] and [[index]]', 'projects/README.md', pages);

    expect(rewritten).toBe('[Home](Home.md) and [index](index.md)');
  });

  /**
   * A label may carry an opening bracket, since the pattern stops at the first `]`. Left
   * unescaped it would open a second link inside the first and take the rest of the line.
   */
  it('escapes a bracket a label carries', () => {
    const odd: WikiPage[] = [{ path: 'odd.md', title: 'Odd' }];
    const rewritten = withResolvedLinks('[[odd|a [thing]] after', 'index.md', odd);

    expect(rewritten).toBe('[a \\[thing](odd.md) after');
  });

  // Stopping at the first `]` is what keeps a link from swallowing the text around it.
  it('leaves a line that never closes the link alone', () => {
    const body = 'see [[Home and nothing else';

    expect(withResolvedLinks(body, 'index.md', pages)).toBe(body);
  });

  it('leaves ordinary markdown links alone', () => {
    const body = 'see [the guide](resources/guides/rtk-install.md)';

    expect(withResolvedLinks(body, 'index.md', pages)).toBe(body);
  });
});

/**
 * A directory's own page, named by convention rather than declared. The candidates are the
 * conventions the real wiki uses: README at the top of each category, overview inside a
 * project or guide.
 */
describe('the page a directory stands for', () => {
  it('takes the readme a category keeps', () => {
    expect(landingPage('projects', pages)).toBe('projects/README.md');
  });

  it('takes the overview a project keeps', () => {
    expect(landingPage('projects/copilot-cli-desktop', pages)).toBe(
      'projects/copilot-cli-desktop/overview.md',
    );
  });

  it('takes a page sharing the directory own name', () => {
    const named: WikiPage[] = [{ path: 'areas/health/health.md', title: 'Health' }];

    expect(landingPage('areas/health', named)).toBe('areas/health/health.md');
  });

  /** A grouping rather than a subject: saying so beats inventing a destination for it. */
  it('says nothing for a directory that is only a grouping', () => {
    expect(landingPage('resources/guides', pages)).toBeNull();
  });

  // A page below a subdirectory is not that directory's own page.
  it('does not reach into a directory below', () => {
    expect(landingPage('resources', pages)).toBeNull();
  });

  it('prefers the readme when a directory has more than one', () => {
    const both: WikiPage[] = [
      { path: 'projects/overview.md', title: 'Overview' },
      { path: 'projects/README.md', title: 'Projects' },
    ];

    expect(landingPage('projects', both)).toBe('projects/README.md');
  });
});

describe('telling a page from an address', () => {
  it('takes a bare path as a page', () => {
    expect(isWikiLink('projects/README.md')).toBe(true);
  });

  it('leaves an address for the system', () => {
    expect(isWikiLink('https://example.com')).toBe(false);
    expect(isWikiLink('mailto:someone@example.com')).toBe(false);
  });

  it('leaves a place in this page to the renderer', () => {
    expect(isWikiLink('#a-heading')).toBe(false);
  });
});
