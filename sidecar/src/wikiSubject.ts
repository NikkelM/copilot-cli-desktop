import type { WikiPage } from '../../shared/protocol.js';

/**
 * The notes a session's subject already has (#35).
 *
 * Two signals, because neither covers what the other does. A repository is structural and
 * precise, and absent or useless for the third of sessions measured to run in a parent
 * folder rather than in a project. A session's tags are chosen by the person working in it
 * and say what it is actually about, which is the same question a wiki page is filed under.
 *
 * Confident matches only, either way. A session opens with this question asked of it rather
 * than by anybody, so an answer that is merely plausible is worse than no answer: it sends
 * a reader to pages about something else and teaches them to stop looking.
 *
 * Measured against the wiki and session store on the machine this was written for - 117
 * pages, 745 sessions with a working directory - which is what settled the guards below.
 */

/** Lowercase, and everything that is not a letter or digit becomes a single dash. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The folders a wiki is organised by rather than named after.
 *
 * The trap this exists for: the most common working directory on that machine was the
 * folder every repository sits inside, called `Projects`, which 262 of 745 sessions ran
 * in. Slugged it is `projects`, which is also the PARA category every project page lives
 * under - so without this, a third of all sessions would have claimed the four pages
 * directly inside it, one of which was about house-hunting.
 *
 * A repository genuinely called `projects` loses a match it would probably not have wanted.
 */
const ORGANISING = new Set(['projects', 'areas', 'resources', 'archives', 'guides', 'references', 'tools', 'glossary']);

/**
 * How much of a wiki a single tag may claim before it stops being about anything.
 *
 * A tag on a third of every page is a shelf, not a subject. Measured here: `hades-ii` is on
 * 67 of 117 pages and `modding` on 65, either of which would have answered "57 notes" to a
 * session tagged the same way - true, and no use to anybody. The tags that do say something
 * are far below it: `hell2modding` is on 9 pages, `map-editor` on 13.
 *
 * A share rather than a count, so it means the same thing in a wiki of 50 pages and of 5000.
 */
const TOO_BROAD = 1 / 3;

/** The name a repository is known by, from `owner/name` or from a working directory. */
export function repositoryName(repository: string | null, cwd: string | null): string | null {
  const from = repository ?? cwd;
  if (!from) return null;

  const leaf = from
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();
  const name = slug(leaf ?? '');
  // A name the wiki organises by says nothing about which repository this is.
  return name && !ORGANISING.has(name) ? name : null;
}

/**
 * The pages about this session's subject, by repository or by the tags it carries.
 *
 * A repository matches a page tagged with its name, or a page inside a folder named after
 * it. The folder is the strongest signal and the rarest - one repository of the sixteen
 * busiest had such a folder - while the tag is what generalises: one project had seven
 * pages by tag and none by folder.
 *
 * A session tag matches a page carrying the same tag, provided the tag is narrow enough to
 * mean something. Any of them is enough rather than all of them: a session tagged
 * `game, timeless manor, unity` is about all three, and a page about any one of them is
 * about part of what that session is doing. Requiring all three matched nothing at all.
 *
 * Prose and summaries are deliberately not consulted either way. The wiki's own search
 * already ranks those and is one keystroke away; a count in a header has to be certain.
 */
export function pagesForSession(
  pages: readonly WikiPage[],
  name: string | null,
  sessionTags: readonly string[] = [],
): WikiPage[] {
  const tagsOn = (page: WikiPage) => (page.tags ?? []).map(slug);

  /** The session's tags, less any too broad to be about a subject. */
  const narrow = new Set(
    [...new Set(sessionTags.map(slug))].filter((tag) => {
      if (!tag) return false;
      const on = pages.filter((page) => tagsOn(page).includes(tag)).length;
      return on > 0 && on < pages.length * TOO_BROAD;
    }),
  );

  if (!name && narrow.size === 0) return [];

  return pages.filter((page) => {
    const tags = tagsOn(page);
    if (tags.some((tag) => narrow.has(tag))) return true;
    if (!name) return false;
    if (tags.includes(name)) return true;

    // Every folder above the page, so `projects/<name>/deep/page.md` counts.
    return page.path
      .replace(/\\/g, '/')
      .split('/')
      .slice(0, -1)
      .some((folder) => slug(folder) === name);
  });
}
