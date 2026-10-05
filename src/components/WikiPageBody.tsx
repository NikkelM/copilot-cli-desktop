import { useCallback, useMemo } from 'react';

import type { WikiPage, WikiPageContent } from '../../shared/protocol';
import { splitFrontmatter } from '../../shared/frontmatter';
import { isWikiLink, resolveWikiLink, withResolvedLinks } from '../lib/wikiLinks';
import { Markdown } from './Markdown';
import { readFrontmatter } from './frontmatterFields';

/**
 * A wiki page, as the file it is or as what it renders to.
 *
 * Its own component because a page is now read in two places - the browser, and the column
 * beside a session (#35) - and every one of the steps below is a way the two could come to
 * disagree. A page that rendered its links in one and showed `[[like this]]` in the other
 * would be the same page looking like two.
 */
export function WikiPageBody({
  page,
  pages,
  source,
  raw,
  loading,
  onEdit,
  onOpen,
  empty = 'Choose a page.',
}: {
  page: WikiPageContent | null;
  /** Every page there is, which is what a wikilink is resolved against. */
  pages: WikiPage[] | null;
  /** What to show: the draft where there is one, otherwise what is on disk. */
  source: string;
  /** Whether to show the file rather than what it renders to. */
  raw: boolean;
  loading: boolean;
  onEdit: (path: string, source: string) => void;
  onOpen: (path: string) => void;
  /** What to say where no page has been chosen, which differs by where this is drawn. */
  empty?: string;
}) {
  /**
   * Split here rather than asked of the sidecar, so previewing an edit costs nothing and
   * works on text that has never been written. Through the same function the sidecar uses,
   * or a page would render differently depending on whether it had been saved yet.
   */
  const shown = useMemo(() => splitFrontmatter(source), [source]);
  const fields = useMemo(() => (shown.frontmatter ? readFrontmatter(shown.frontmatter) : []), [shown.frontmatter]);

  /**
   * The body with its wikilinks rewritten as ordinary links.
   *
   * The renderer has never heard of `[[page]]`, and this wiki is written almost entirely in
   * them - 315 of them against 65 ordinary links - so leaving them would show most of its
   * cross-references as punctuation.
   */
  const body = useMemo(
    () => (page && pages ? withResolvedLinks(shown.body, page.path, pages) : shown.body),
    [shown.body, page, pages],
  );

  /**
   * Where a link in the page leads, kept stable so the renderer can skip its work.
   *
   * `Markdown` is memoised and parses the whole page when it runs. An arrow built here in
   * the body would be a new prop every render, so it would never skip - and this column is
   * drawn inside an app that re-renders on every streamed event and every pointer move of
   * a drag. Measured on this wiki, that is a parse of several thousand words a frame.
   */
  const follow = useCallback(
    (href: string) => {
      // Only a link to another page in this wiki is this app's to follow. Anything else is
      // a link to the web, which the renderer already knows what to do with.
      //
      // The hash half of this is belt and braces: the renderer intercepts a link to a
      // heading before it asks, so one never arrives here. It is kept because what may be
      // followed is this component's rule rather than the renderer's order.
      if (!page || !pages || !isWikiLink(href)) return false;
      const found = resolveWikiLink(decodeURI(href), page.path, pages);
      // Handed back rather than claimed, so a link naming no page falls to the ordinary
      // rules instead of being swallowed by a handler that does nothing.
      if (!found) return false;

      onOpen(found.path);
      return true;
    },
    [page, pages, onOpen],
  );

  if (raw && page) {
    return (
      <textarea
        className="wiki-source"
        value={source}
        spellCheck={false}
        aria-label={`Source of ${page.path}`}
        onChange={(event) => onEdit(page.path, event.target.value)}
      />
    );
  }

  return (
    <>
      {fields.length > 0 && (
        <dl className="wiki-meta">
          {fields.map((field) => (
            <div key={field.key}>
              <dt>{field.key}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {loading && !page ? (
        <p className="wiki-empty">Reading…</p>
      ) : page ? (
        <Markdown body={body} anchor={page.path} onLink={follow} />
      ) : (
        <p className="wiki-empty">{empty}</p>
      )}
    </>
  );
}
