import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { splitFrontmatter } from '../../shared/frontmatter.js';
import type { WikiSearchResult } from '../../shared/protocol.js';

/**
 * Searching the knowledge base.
 *
 * The weights are `Search-Wiki.ps1`'s, kept deliberately rather than invented: the same
 * question asked from the app and from a terminal should not answer differently, and that
 * script is what its reader already knows. Where a term is found is ranked above how often -
 * a term among a page's keywords says the page is about it, while a term in the prose may
 * only say the word appeared.
 */
const WEIGHT = { keywords: 10, title: 8, headings: 5, summary: 4, tags: 3 } as const;

/** How much one term's presence in the prose can add, however many times it appears. */
const MAX_BODY = 5;

/** Two letters, below which a term matches most of the wiki and so ranks nothing. */
const MIN_TERM = 2;

/** How much text to show around a match, split either side of it. */
const EXCERPT = 160;

/** Where a page matched, named as the index names them. */
export type MatchField = 'keywords' | 'title' | 'headings' | 'summary' | 'tags' | 'content';

/**
 * A page as the index describes it.
 *
 * More than the browser's tree needs - keywords and headings are what make the ranking worth
 * anything - so this is the index's own shape rather than the protocol's.
 */
export interface IndexedPage {
  path: string;
  title: string;
  summary?: string;
  /**
   * Absent means unknown, and is not the same as empty.
   *
   * An index that describes a page without keywords has said it has none, and none must be
   * invented for it - that would rank it differently here than from the terminal. A page no
   * index describes has said nothing, so its own text is read for them.
   */
  keywords?: string[];
  headings?: string[];
  tags?: string[];
}

/** The headings a page carries, for ranking a wiki that has no prebuilt index. */
export function headingsIn(body: string): string[] {
  return body
    .split('\n')
    .map((line) => /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter((heading): heading is string => Boolean(heading));
}

/** The terms a query asks about, which are the words long enough to mean something. */
export function termsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= MIN_TERM);
}

/** How many times a term appears, counted without a pattern that would need escaping. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * The prose around the first term to appear in it, for a reader deciding whether to open the
 * page.
 *
 * Headings are left out along with the frontmatter, and for the same reason: a page's title
 * appears in its frontmatter, again as its first heading, and once more in the result above
 * this - so an excerpt drawn from either gave the reader the title three times and told them
 * nothing. What is wanted is a sentence somebody wrote.
 *
 * Note this is not where the score comes from: scoring reads the whole file, because the
 * wiki's own search script does, and matching its ranking matters more than tidiness. What is
 * counted and what is shown are allowed to differ, and here they should.
 */
export function excerptAround(source: string, terms: string[]): string | null {
  const { body } = splitFrontmatter(source);
  const prose = body
    .split('\n')
    .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
    .join('\n');

  const lowered = prose.toLowerCase();
  let first = -1;

  for (const term of terms) {
    const at = lowered.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  if (first === -1) return null;

  const from = Math.max(0, first - EXCERPT / 2);
  const to = Math.min(prose.length, first + EXCERPT / 2);
  const text = prose.slice(from, to).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  return `${from > 0 ? '…' : ''}${text}${to < prose.length ? '…' : ''}`;
}

const lowerAll = (values: readonly string[] | undefined): string[] =>
  (values ?? []).filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase());

/**
 * Score one page against the terms, and say where it matched.
 *
 * Each field counts once per term however many times the term appears in it - a page does not
 * become twice as relevant for repeating a word across two headings - except in the prose,
 * where repetition is the only signal there is, and is capped.
 */
export function scorePage(
  page: IndexedPage,
  body: string,
  terms: string[],
): { score: number; matched: MatchField[] } {
  const keywords = lowerAll(page.keywords);
  const headings = lowerAll(page.headings);
  const tags = lowerAll(page.tags);
  const title = page.title.toLowerCase();
  const summary = (page.summary ?? '').toLowerCase();
  const prose = body.toLowerCase();

  let score = 0;
  let termsMatched = 0;
  /**
   * Where it matched, kept in weight order.
   *
   * Insertion order is the order of the checks below, which is the order of the weights, so
   * the first entry is always the strongest reason the page ranked - which is the only one
   * worth showing a reader.
   */
  const matched = new Set<MatchField>();

  for (const term of terms) {
    let hit = false;

    if (keywords.some((keyword) => keyword.includes(term))) {
      score += WEIGHT.keywords;
      matched.add('keywords');
      hit = true;
    }
    if (title.includes(term)) {
      score += WEIGHT.title;
      matched.add('title');
      hit = true;
    }
    if (headings.some((heading) => heading.includes(term))) {
      score += WEIGHT.headings;
      matched.add('headings');
      hit = true;
    }
    if (summary.includes(term)) {
      score += WEIGHT.summary;
      matched.add('summary');
      hit = true;
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += WEIGHT.tags;
      matched.add('tags');
      hit = true;
    }

    const inProse = prose ? occurrences(prose, term) : 0;
    if (inProse > 0) {
      score += Math.min(inProse, MAX_BODY);
      matched.add('content');
      hit = true;
    }

    if (hit) termsMatched += 1;
  }

  // A page answering every word of a question is worth more than one answering a single word
  // very loudly, which the per-field weights alone do not say.
  if (termsMatched > 1) score += (termsMatched - 1) * 2;

  return { score, matched: [...matched] };
}

/**
 * The pages answering a query, best first.
 *
 * Bodies are read from disk rather than indexed. The index does not hold them, and a second
 * index would be a second thing to keep true - where this wiki is under a megabyte of
 * markdown, which is cheaper to read than to keep correct.
 */
export async function searchWiki(
  root: string,
  pages: IndexedPage[],
  query: string,
  limit: number,
): Promise<WikiSearchResult[]> {
  const terms = termsOf(query);
  if (terms.length === 0) return [];

  const read = await Promise.all(
    pages.map(async (page) => {
      try {
        return { page, body: await readFile(join(root, ...page.path.split('/')), 'utf8') };
      } catch {
        // Listed but unreadable. Its metadata can still answer, so it is not dropped.
        return { page, body: '' };
      }
    }),
  );

  return read
    .map(({ page, body }) => {
      // Said nothing about its headings, so the text says instead. An index that described
      // the page has already answered, even if the answer was none.
      const described = page.headings === undefined ? { ...page, headings: headingsIn(body) } : page;
      return { page: described, body, ...scorePage(described, body, terms) };
    })
    .filter((result) => result.score > 0)
    // Path second, so an equal score gives the same order every time rather than whichever
    // one the filesystem happened to list first.
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path))
    .slice(0, limit)
    .map(({ page, body, score, matched }) => {
      const excerpt = excerptAround(body, terms);
      return {
        path: page.path,
        title: page.title,
        score,
        matchedIn: matched,
        ...(page.summary ? { summary: page.summary } : {}),
        ...(excerpt ? { excerpt } : {}),
      };
    });
}






