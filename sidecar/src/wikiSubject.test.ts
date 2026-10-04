import { describe, expect, it } from 'vitest';

import { pagesForSession, repositoryName } from './wikiSubject.js';
import type { WikiPage } from '../../shared/protocol.js';

const page = (path: string, tags?: string[]): WikiPage => ({
  path,
  title: path.split('/').pop()!.replace('.md', ''),
  ...(tags ? { tags } : {}),
});

/** Enough pages that a tag on one of them is nowhere near a third of the wiki. */
const filler = (n: number) => Array.from({ length: n }, (_, i) => page(`resources/filler-${i}.md`, ['unrelated']));

/**
 * The notes a session's subject already has (#35).
 *
 * Confident matches only. The question is asked on the session's behalf rather than by
 * anybody, so an answer that is merely plausible is worse than none: it sends a reader to
 * pages about something else and teaches them to stop looking.
 */
describe('naming the repository a session is in', () => {
  it('takes the last part of a repository', () => {
    expect(repositoryName('NikkelM/copilot-cli-desktop', null)).toBe('copilot-cli-desktop');
  });

  it('falls back to the working directory where there is no repository', () => {
    expect(repositoryName(null, 'G:\\Users\\nikke\\Projects\\Hades-II-HadesBiomes')).toBe('hades-ii-hadesbiomes');
  });

  it('prefers the repository, which is the name the notes would use', () => {
    expect(repositoryName('NikkelM/copilot-cli-desktop', 'C:\\somewhere\\else')).toBe('copilot-cli-desktop');
  });

  /** A name written three ways is one repository, and the wiki writes it a fourth. */
  it('reads a name however it was capitalised or spaced', () => {
    expect(repositoryName(null, 'D:\\work\\Random YouTube Video')).toBe('random-youtube-video');
    expect(repositoryName(null, 'D:\\work\\NikkelM.Github.io')).toBe('nikkelm-github-io');
  });

  it('reads a path however it was separated, and whatever it ends with', () => {
    expect(repositoryName(null, '/home/nikke/projects/my-repo/')).toBe('my-repo');
    expect(repositoryName(null, 'C:\\repos\\my-repo\\')).toBe('my-repo');
  });

  it('says nothing about a session with neither', () => {
    expect(repositoryName(null, null)).toBeNull();
  });

  /**
   * The trap this exists for. The most common working directory measured was the folder
   * every repository sits inside, called `Projects` - 262 of 745 sessions - which slugs to
   * the PARA category every project page lives under. Without this a third of all sessions
   * would have claimed the pages directly inside it, one of which was about house-hunting.
   */
  it('refuses a folder the wiki organises by rather than names a repository', () => {
    expect(repositoryName(null, 'G:\\Users\\nikke\\OneDrive\\Privat\\Projects')).toBeNull();
    expect(repositoryName(null, '/home/nikke/resources')).toBeNull();
    expect(repositoryName(null, '/home/nikke/guides')).toBeNull();
  });

  it('refuses a path that slugs to nothing at all', () => {
    expect(repositoryName(null, '///')).toBeNull();
  });
});

describe('the pages about a repository', () => {
  const wiki = [
    page('projects/copilot-cli-desktop/conventions.md'),
    page('projects/copilot-cli-desktop/deep/notes.md'),
    page('resources/guides/hades-ii-h2m-imgui-menus.md', ['Hell2Modding', 'hades-ii']),
    page('resources/guides/unrelated.md', ['cooking']),
    page('projects/dublin-house-hunting.md'),
  ];

  it('finds the pages in a folder named after it', () => {
    expect(pagesForSession(wiki, 'copilot-cli-desktop').map((p: WikiPage) => p.path)).toEqual([
      'projects/copilot-cli-desktop/conventions.md',
      'projects/copilot-cli-desktop/deep/notes.md',
    ]);
  });

  /** The rule that generalises: one project measured had seven pages by tag and none by folder. */
  it('finds the pages tagged with it, wherever they are filed', () => {
    expect(pagesForSession(wiki, 'hell2modding').map((p: WikiPage) => p.path)).toEqual([
      'resources/guides/hades-ii-h2m-imgui-menus.md',
    ]);
  });

  it('reads a tag however it was written', () => {
    expect(pagesForSession([page('a.md', ['Random YouTube Video'])], 'random-youtube-video')).toHaveLength(1);
  });

  it('says nothing where no page names it', () => {
    expect(pagesForSession(wiki, 'hades-ii-hadesbiomes')).toEqual([]);
  });

  it('says nothing where the session has neither a name nor tags', () => {
    expect(pagesForSession(wiki, null)).toEqual([]);
  });

  /**
   * A page is about a repository or it is not. Summaries and prose mention a project in
   * passing all the time, and the wiki's own search already ranks those a keystroke away.
   */
  it('does not count a page that merely mentions it', () => {
    const mentions = [
      {
        path: 'resources/guides/thing.md',
        title: 'Working with copilot-cli-desktop',
        summary: 'about copilot-cli-desktop',
      },
    ];

    expect(pagesForSession(mentions, 'copilot-cli-desktop')).toEqual([]);
  });

  it('counts a page once even where both rules match it', () => {
    expect(pagesForSession([page('projects/my-repo/page.md', ['my-repo'])], 'my-repo')).toHaveLength(1);
  });

  it('reads a path written with backslashes', () => {
    expect(pagesForSession([page('projects\\my-repo\\page.md')], 'my-repo')).toHaveLength(1);
  });

  /** The folder has to be the name, not merely contain it. */
  it('does not match a folder that only starts with the name', () => {
    expect(pagesForSession([page('projects/my-repo-archive/page.md')], 'my-repo')).toEqual([]);
  });

  /** The file is the page, not a folder, so a page named after the repo is not a folder match. */
  it('does not treat the page itself as a folder', () => {
    expect(pagesForSession([page('resources/my-repo.md')], 'my-repo')).toEqual([]);
  });
});

/**
 * The tags a session carries, which say what it is about in the reader's own words.
 *
 * A repository is structural and precise, and useless for the third of sessions measured to
 * run in a parent folder rather than in a project. Tags are what is left to go on there, and
 * they are also what the person working in the session chose to say about it.
 */
describe('the pages matching a session\u2019s tags', () => {
  const wiki = [
    page('resources/tools/unity-cli.md', ['unity', 'tooling']),
    page('projects/timeless-manor.md', ['timeless-manor', 'unity']),
    page('resources/guides/cooking.md', ['cooking']),
    ...filler(20),
  ];

  it('finds a page carrying a tag the session carries', () => {
    expect(pagesForSession(wiki, null, ['unity']).map((p: WikiPage) => p.path)).toEqual([
      'resources/tools/unity-cli.md',
      'projects/timeless-manor.md',
    ]);
  });

  /**
   * Any of them rather than all. A session tagged `game, timeless manor, unity` is about all
   * three, and a page about any one is about part of what it is doing. Requiring all three
   * matched nothing at all in the wiki this was measured against.
   */
  it('takes any of the session\u2019s tags rather than all of them', () => {
    const found = pagesForSession(wiki, null, ['timeless-manor', 'cooking']);

    expect(found.map((p: WikiPage) => p.path)).toEqual(['projects/timeless-manor.md', 'resources/guides/cooking.md']);
  });

  it('reads a session tag however it was written', () => {
    expect(pagesForSession(wiki, null, ['Timeless Manor'])).toHaveLength(1);
  });

  it('says nothing for a tag no page carries', () => {
    expect(pagesForSession(wiki, null, ['ireland'])).toEqual([]);
  });

  it('adds what the tags find to what the repository finds', () => {
    const both = [page('projects/my-repo/page.md'), page('resources/other.md', ['unity']), ...filler(20)];

    expect(pagesForSession(both, 'my-repo', ['unity']).map((p: WikiPage) => p.path)).toEqual([
      'projects/my-repo/page.md',
      'resources/other.md',
    ]);
  });

  it('counts a page once where the repository and a tag both match it', () => {
    expect(pagesForSession([page('projects/my-repo/page.md', ['unity']), ...filler(20)], 'my-repo', ['unity'])).toHaveLength(1);
  });

  /**
   * A tag on a third of every page is a shelf, not a subject.
   *
   * Measured: `hades-ii` was on 67 of 117 pages and `modding` on 65. A session tagged either
   * would have been told it had 57 notes, which is true and no use to anybody.
   */
  const shelf = [
    page('a.md', ['modding']),
    page('b.md', ['modding']),
    page('c.md', ['modding']),
    page('d.md', ['narrow']),
  ];

  it('ignores a tag that most of the wiki carries', () => {
    expect(pagesForSession(shelf, null, ['modding'])).toEqual([]);
  });

  it('still takes a tag only a few pages carry', () => {
    expect(pagesForSession(shelf, null, ['narrow']).map((p: WikiPage) => p.path)).toEqual(['d.md']);
  });

  /** The repository is a name rather than a tag anybody chose, so breadth does not disqualify it. */
  it('does not hold the repository to the same test', () => {
    const many = [page('projects/big/one.md'), page('projects/big/two.md'), page('elsewhere.md')];

    expect(pagesForSession(many, 'big')).toHaveLength(2);
  });

  it('ignores an empty tag', () => {
    expect(pagesForSession(wiki, null, ['', '   '])).toEqual([]);
  });

  it('asks nothing of a wiki with no pages', () => {
    expect(pagesForSession([], 'my-repo', ['unity'])).toEqual([]);
  });
});
