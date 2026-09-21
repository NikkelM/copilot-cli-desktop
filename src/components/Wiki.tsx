import { useEffect, useMemo, useState } from 'react';

import type { WikiPage, WikiPageContent, WikiSearchResult } from '../../shared/protocol';
import { splitFrontmatter } from '../../shared/frontmatter';
import { isWikiLink, resolveWikiLink, withResolvedLinks } from '../lib/wikiLinks';
import { ChevronIcon } from './Icons';
import { Markdown } from './Markdown';

interface WikiProps {
  pages: WikiPage[] | null;
  /** Where the wiki is read from, and whether it is there. Null until that is known. */
  where: { root: string; exists: boolean } | null;
  page: WikiPageContent | null;
  loading: boolean;
  failed: string | null;
  saving: boolean;
  /** What an editor holds for this page, or nothing when there are no unsaved edits. */
  draft: string | undefined;
  /** Pages with edits not yet written, so the tree can mark them. */
  unsaved: string[];
  onEdit: (path: string, source: string) => void;
  onRevert: (path: string) => void;
  onSave: (path: string) => void;
  /** Start a knowledge base where there is none, and open what it starts with. */
  onCreate: () => void;
  /** What is being searched for, and what came back. Null results mean nothing is being asked. */
  query: string;
  onQuery: (query: string) => void;
  results: WikiSearchResult[] | null;
  onOpen: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Where the reader has been, newest last, including the page they are on. */
  trail: string[];
  onClose: () => void;
}

/**
 * How many steps of the walk are worth showing.
 *
 * The pages just before this one are what a reader is placing themselves against; the
 * start of a long walk is not, and a trail that grows without limit would push the buttons
 * beside it off the header.
 */
const TRAIL_LENGTH = 5;

/** A directory in the tree, holding pages and the directories below it. */
interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  pages: WikiPage[];
}

/**
 * The pages arranged as the directories hold them.
 *
 * A flat list would be a hundred and eleven rows of path, and the wiki's shape is the PARA
 * structure it is organised by - which is worth showing rather than flattening away.
 */
export function asTree(pages: WikiPage[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], pages: [] };

  for (const page of pages) {
    const parts = page.path.split('/');
    let at = root;

    for (const step of parts.slice(0, -1)) {
      const here = `${at.path ? `${at.path}/` : ''}${step}`;
      let next = at.folders.find((folder) => folder.name === step);
      if (!next) {
        next = { name: step, path: here, folders: [], pages: [] };
        at.folders.push(next);
      }
      at = next;
    }

    at.pages.push(page);
  }

  return root;
}

/** One directory and everything below it, folded away until it is asked for. */
function FolderRow({
  folder,
  openPath,
  onOpen,
  unsaved,
  depth,
}: {
  folder: Folder;
  openPath: string | null;
  onOpen: (path: string) => void;
  unsaved: string[];
  depth: number;
}) {
  // Opened when the page being read is inside it, so following a link into a folded
  // directory does not leave the tree pointing somewhere else.
  const holdsOpen = openPath?.startsWith(`${folder.path}/`) ?? false;
  const [open, setOpen] = useState(holdsOpen);
  const [was, setWas] = useState(holdsOpen);
  if (holdsOpen !== was) {
    setWas(holdsOpen);
    if (holdsOpen) setOpen(true);
  }

  return (
    <li>
      <button type="button" className="wiki-folder-head" aria-expanded={open} onClick={() => setOpen((it) => !it)}>
        <ChevronIcon open={open} />
        <span className="wiki-folder-name">{folder.name}</span>
        <span className="wiki-folder-count">{folder.pages.length + folder.folders.length}</span>
      </button>
      {open && <FolderBody folder={folder} openPath={openPath} onOpen={onOpen} unsaved={unsaved} depth={depth + 1} />}
    </li>
  );
}

function FolderBody({
  folder,
  openPath,
  onOpen,
  unsaved,
  depth,
}: {
  folder: Folder;
  openPath: string | null;
  onOpen: (path: string) => void;
  unsaved: string[];
  depth: number;
}) {
  return (
    <ul className="wiki-tree" style={{ '--depth': depth } as React.CSSProperties}>
      {folder.folders.map((child) => (
        <FolderRow
          key={child.path}
          folder={child}
          openPath={openPath}
          onOpen={onOpen}
          unsaved={unsaved}
          depth={depth}
        />
      ))}
      {folder.pages.map((page) => (
        <li key={page.path}>
          <button
            type="button"
            className={page.path === openPath ? 'wiki-page on' : 'wiki-page'}
            title={page.summary ?? page.path}
            onClick={() => onOpen(page.path)}
          >
            {page.title}
            {/* A page can be left with edits and navigated away from, so the tree says
                which ones are waiting rather than letting them be forgotten. */}
            {unsaved.includes(page.path) && (
              <span className="wiki-dirty-mark" title="Unsaved edits">
                •
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The fields a page declares about itself, shown as what they are.
 *
 * Read here rather than in the sidecar, which hands the block over as written: what the
 * fields mean is a question about this wiki's conventions, and a page whose frontmatter
 * cannot be made sense of should still be readable.
 *
 * A deliberately small reading of YAML - `key: value` and `- item` lists, which is all the
 * schema uses. Anything else is shown as the line it was written as rather than guessed at.
 */
export function readFrontmatter(source: string): Array<{ key: string; value: string }> {
  const fields: Array<{ key: string; value: string }> = [];

  for (const line of source.split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && fields.length > 0) {
      const last = fields[fields.length - 1]!;
      last.value = last.value ? `${last.value}, ${item[1]!.trim()}` : item[1]!.trim();
      continue;
    }

    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields.push({ key: field[1]!, value: field[2]!.trim().replace(/^["']|["']$/g, '') });
  }

  return fields.filter((field) => field.value !== '');
}

/**
 * How the reader got here, as the pages they came through.
 *
 * The path was shown here first, and it answered the wrong question: at the root of the
 * wiki a page's path is only its own filename, which says nothing, and it could not show
 * that this page was reached from the index. A trail says both - where the reader has
 * been, and that the page they are on is the end of it.
 *
 * Clipped from the left when it gets long, because the pages just before this one are the
 * ones worth seeing and the start of a long walk is not.
 */
function Trail({
  trail,
  pages,
  onOpen,
}: {
  trail: string[];
  pages: WikiPage[];
  onOpen: (path: string) => void;
}) {
  const shown = trail.slice(-TRAIL_LENGTH);
  const nameOf = (path: string) => pages.find((page) => page.path === path)?.title ?? path;

  return (
    <nav className="wiki-crumbs" aria-label="How you got here">
      {trail.length > shown.length && <span className="wiki-crumb-sep">…</span>}
      {shown.map((path, index) => {
        const here = index === shown.length - 1;

        return (
          <span key={`${path}:${index}`}>
            {here ? (
              // Where the reader already is, so it says so rather than offering to go there.
              <span className="wiki-crumb plain here">{nameOf(path)}</span>
            ) : (
              <button type="button" className="wiki-crumb" onClick={() => onOpen(path)}>
                {nameOf(path)}
              </button>
            )}
            {!here && <span className="wiki-crumb-sep">›</span>}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * What to do when there is no knowledge base to browse.
 *
 * The browser has to explain itself to someone meeting it for the first time. Left as an
 * empty tree it is a feature that appears broken, and the idea it rests on - a folder of
 * markdown the app can read - is not one it can assume anybody has heard of.
 *
 * An empty wiki and a missing one are told apart, because they need different sentences:
 * one needs the folder made, the other only needs a page put in it.
 */
function Onboarding({
  root,
  exists,
  onCreate,
  creating,
}: {
  root: string;
  exists: boolean;
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <div className="wiki-onboarding">
      <h2>{exists ? 'No pages here yet' : 'No knowledge base yet'}</h2>
      <p>
        This reads a folder of markdown files as a browsable knowledge base - the notes worth
        keeping between sessions, where the work is rather than in another window.
      </p>

      {/* The instruction was a folder to go and make by hand, which is a strange thing to
          be told by an app that could make it. */}
      <p>
        <button type="button" className="changes-action primary" onClick={onCreate} disabled={creating}>
          {creating ? 'Creating…' : exists ? 'Write a first page' : 'Create it'}
        </button>
        <span className="wiki-onboarding-where">
          {exists ? 'in' : 'at'} <code>{root}</code>
        </span>
      </p>

      {/* How a page is put together is not listed here: the page this writes says it, and
          saying it twice a click apart is asking to be read twice. */}
      <p className="wiki-onboarding-note">
        Somewhere else suits you better? Set <code>COPILOT_WIKI_DIR</code> and this reads from
        there instead.
      </p>
    </div>
  );
}

/**
 * What a search found, in place of the tree.
 *
 * In place of rather than beside it: they answer the same question - which page do I want -
 * and two lists offering pages at once would be two things to look at instead of one.
 */
function Results({
  results,
  openPath,
  onOpen,
}: {
  results: WikiSearchResult[];
  openPath: string | null;
  onOpen: (path: string) => void;
}) {
  if (results.length === 0) return <p className="wiki-empty">Nothing matches that.</p>;

  return (
    <ul className="wiki-results">
      {results.map((result) => (
        <li key={result.path}>
          <button
            type="button"
            className={result.path === openPath ? 'wiki-result on' : 'wiki-result'}
            onClick={() => onOpen(result.path)}
          >
            <span className="wiki-result-title">{result.title}</span>
            {/* A sentence somebody wrote, preferred in this order: the prose around the
                match, then the page's own description, then - for a page found by its
                keywords with nothing to quote - the strongest reason it ranked. Listing all
                six fields, which is what this was, said nothing: most pages match on most
                of them. */}
            {result.excerpt ? (
              <span className="wiki-result-excerpt">{result.excerpt}</span>
            ) : result.summary ? (
              <span className="wiki-result-excerpt">{result.summary}</span>
            ) : (
              result.matchedIn[0] && <span className="wiki-result-where">in its {result.matchedIn[0]}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The local knowledge base, browsable without leaving the app.
 *
 * Read-only. The helper scripts remain the way to write pages, and a viewer that could
 * half-edit them would be worse than one that plainly cannot.
 */
export function Wiki({
  pages,
  where,
  page,
  loading,
  failed,
  saving,
  draft,
  unsaved,
  onEdit,
  onRevert,
  onSave,
  onCreate,
  query,
  onQuery,
  results,
  onOpen,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  trail,
  onClose,
}: WikiProps) {
  const tree = useMemo(() => (pages ? asTree(pages) : null), [pages]);
  const title = pages?.find((each) => each.path === page?.path)?.title ?? page?.path ?? 'Wiki';
  /** Nothing to browse, which is the case the browser has to explain itself for. */
  const empty = where !== null && pages !== null && pages.length === 0;
  /**
   * Whether the page is shown as the file it is rather than as what it renders to.
   *
   * Per page rather than a mode the whole browser is in: turning it on to fix a typo and
   * then reading three pages of source is not what was asked for.
   *
   * Unsaved edits do not force it either way. Previewing what has been written before
   * committing it is most of the reason to have both views, so the toggle keeps working
   * while a page is dirty and the preview renders the draft rather than the file.
   */
  const [raw, setRaw] = useState(false);
  const source = draft ?? page?.source ?? '';
  useEffect(() => setRaw(false), [page?.path]);

  /**
   * What is rendered, which is the draft when there is one.
   *
   * Split here rather than asked of the sidecar, so previewing an edit costs nothing and
   * works on text that has never been written. Through the same function the sidecar uses,
   * or a page would render differently depending on whether it had been saved yet.
   */
  const shownSource = useMemo(() => splitFrontmatter(source), [source]);
  const fields = useMemo(
    () => (shownSource.frontmatter ? readFrontmatter(shownSource.frontmatter) : []),
    [shownSource.frontmatter],
  );

  /**
   * The body with its wikilinks rewritten as ordinary links.
   *
   * The renderer has never heard of `[[page]]`, and this wiki is written almost entirely in
   * them - 315 of them against 65 ordinary links - so leaving them would show most of its
   * cross-references as punctuation.
   */
  const body = useMemo(
    () => (page && pages ? withResolvedLinks(shownSource.body, page.path, pages) : shownSource.body),
    [shownSource.body, page, pages],
  );

  /**
   * The gestures that already mean back, wherever the reader's hands are.
   *
   * A button alone makes retracing a trip to the header, and both of these are what a
   * reader moving through linked pages reaches for without thinking. The mouse's back
   * button has to be claimed on the way down as well: left alone the webview treats it as
   * navigation and leaves the app, which there is no way back from.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Saving works from either view, because previewing an edit is part of writing it and
      // the key should not stop meaning save the moment the text goes out of sight.
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        if (page && draft !== undefined) onSave(page.path);
        return;
      }

      if (!event.altKey) return;
      if (event.key === 'ArrowLeft' && canGoBack) {
        event.preventDefault();
        onBack();
      } else if (event.key === 'ArrowRight' && canGoForward) {
        event.preventDefault();
        onForward();
      }
    };

    // Buttons 3 and 4 are the thumb buttons, back and forward. Claimed here so the webview
    // does not navigate, and acted on when released, which is when a click has happened.
    const claim = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) event.preventDefault();
    };

    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.button === 3 && canGoBack) onBack();
      if (event.button === 4 && canGoForward) onForward();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', claim);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', claim);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [canGoBack, canGoForward, onBack, onForward, page, draft, onSave]);

  return (
    <>
      <header className="main-header">
        <h1>{title}</h1>
        <div className="header-row">
          {/* Named for where it goes. It sits beside an arrow rather than another word, so
              there is no second "back" for it to be confused with. */}
          <button type="button" className="changes-action" onClick={onClose}>
            Back to session
          </button>
          {/* Disabled rather than absent, so the header does not move as the reader
              navigates. The gestures above do the same thing. */}
          <button
            type="button"
            className="changes-action"
            onClick={onBack}
            disabled={!canGoBack}
            title="Back a page (Alt+Left, or the mouse's back button)"
          >
            ←
          </button>
          <button
            type="button"
            className="changes-action"
            onClick={onForward}
            disabled={!canGoForward}
            title="Forward a page (Alt+Right, or the mouse's forward button)"
          >
            →
          </button>
          {trail.length > 0 && <Trail trail={trail} pages={pages ?? []} onOpen={onOpen} />}

          {/* Top right, away from the navigation: what it switches is the page rather than
              where the reader is. */}
          {page && (
            <div className="wiki-edit-actions">
              {draft !== undefined && (
                <>
                  {/* No label saying "unsaved" beside them: two buttons offering to save or
                      discard are what having something unsaved looks like. */}
                  <button
                    type="button"
                    className="changes-action"
                    onClick={() => onRevert(page.path)}
                    disabled={saving}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="changes-action primary"
                    onClick={() => onSave(page.path)}
                    disabled={saving}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
              <button
                type="button"
                className={raw ? 'changes-action on' : 'changes-action'}
                onClick={() => setRaw((was) => !was)}
                aria-pressed={raw}
              >
                {raw ? 'Preview' : 'Raw'}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* The row .main reserves for notices, kept even when there is nothing to say: the
          grid assigns its rows by position. */}
      <div>{failed && <p className="error">{failed}</p>}</div>

      {/* Nothing to browse, so the tree gives its space to an explanation instead: an
          empty tree beside an empty page is a feature that looks broken. */}
      {empty ? (
        <div className="wiki">
          <Onboarding root={where.root} exists={where.exists} onCreate={onCreate} creating={saving} />
        </div>
      ) : (
        <div className="wiki">
          <nav className="wiki-nav" aria-label="Wiki pages">
            <div className="wiki-search">
              <input
                type="search"
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                placeholder="Search the wiki"
                spellCheck={false}
                aria-label="Search the wiki"
              />
            </div>

            {results !== null ? (
              <Results results={results} openPath={page?.path ?? null} onOpen={onOpen} />
            ) : tree === null ? (
              <p className="wiki-empty">Reading the wiki…</p>
            ) : (
              <FolderBody folder={tree} openPath={page?.path ?? null} onOpen={onOpen} unsaved={unsaved} depth={0} />
            )}
          </nav>

          <article className="wiki-page-body">
            {/* The page as the file it is, which is also how it is edited. No metadata
                strip above it: the frontmatter is in the text being edited. */}
            {raw && page ? (
              <textarea
                className="wiki-source"
                value={source}
                spellCheck={false}
                aria-label={`Source of ${page.path}`}
                onChange={(event) => onEdit(page.path, event.target.value)}
              />
            ) : (
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
                  <Markdown
                    body={body}
                    anchor={page.path}
                    onLink={(href) => {
                      if (!isWikiLink(href) || !pages) return false;
                      const found = resolveWikiLink(decodeURI(href), page.path, pages);
                      if (!found) return false;

                      onOpen(found.path);
                      return true;
                    }}
                  />
                ) : (
                  <p className="wiki-empty">Choose a page.</p>
                )}
              </>
            )}
          </article>
        </div>
      )}

      {/* Where the pages come from, which nothing else on screen says. The rest of what
          this view can do is said by the buttons that do it. */}
      <div className="footer">
        <p className="changes-note">{where ? where.root : ''}</p>
      </div>
    </>
  );
}




