import { useEffect, useMemo, useState } from 'react';

import type { WikiPage, WikiPageContent } from '../../shared/protocol';
import { isWikiLink, landingPage, resolveWikiLink, withResolvedLinks } from '../lib/wikiLinks';
import { ChevronIcon } from './Icons';
import { Markdown } from './Markdown';

interface WikiProps {
  pages: WikiPage[] | null;
  page: WikiPageContent | null;
  loading: boolean;
  failed: string | null;
  onOpen: (path: string) => void;
  onBack: () => void;
  canGoBack: boolean;
  onClose: () => void;
}

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
  depth,
}: {
  folder: Folder;
  openPath: string | null;
  onOpen: (path: string) => void;
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
    <li className="wiki-folder">
      <button type="button" className="wiki-folder-head" aria-expanded={open} onClick={() => setOpen((it) => !it)}>
        <ChevronIcon open={open} />
        <span className="wiki-folder-name">{folder.name}</span>
        <span className="wiki-folder-count">{folder.pages.length + folder.folders.length}</span>
      </button>
      {open && <FolderBody folder={folder} openPath={openPath} onOpen={onOpen} depth={depth + 1} />}
    </li>
  );
}

function FolderBody({
  folder,
  openPath,
  onOpen,
  depth,
}: {
  folder: Folder;
  openPath: string | null;
  onOpen: (path: string) => void;
  depth: number;
}) {
  return (
    <ul className="wiki-tree" style={{ '--depth': depth } as React.CSSProperties}>
      {folder.folders.map((child) => (
        <FolderRow key={child.path} folder={child} openPath={openPath} onOpen={onOpen} depth={depth} />
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
 * Where the page being read sits, as the parts of its path.
 *
 * The path was already shown here as text. Made of parts it says the same thing and also
 * goes somewhere, which is what a reader who has followed three links into a subject
 * actually wants - the way up, rather than only the way back.
 */
function Breadcrumb({
  path,
  pages,
  onOpen,
}: {
  path: string;
  pages: WikiPage[];
  onOpen: (path: string) => void;
}) {
  const parts = path.split('/');

  return (
    <nav className="wiki-crumbs" aria-label="Where this page sits">
      {parts.slice(0, -1).map((name, index) => {
        const folder = parts.slice(0, index + 1).join('/');
        const landing = landingPage(folder, pages);
        // A crumb pointing at the page already open is a link that does nothing. Common
        // rather than rare: a directory's page is usually the one read on the way in.
        const goes = landing && landing !== path ? landing : null;

        return (
          <span key={folder}>
            {goes ? (
              <button type="button" className="wiki-crumb" onClick={() => onOpen(goes)}>
                {name}
              </button>
            ) : (
              /* A grouping rather than a subject, and saying so by not being a link beats
                 inventing a destination for it. */
              <span className="wiki-crumb plain">{name}</span>
            )}
            <span className="wiki-crumb-sep">/</span>
          </span>
        );
      })}
      {/* The page itself, which is where the reader already is. */}
      <span className="wiki-crumb plain">{parts[parts.length - 1]}</span>
    </nav>
  );
}

/**
 * The local knowledge base, browsable without leaving the app.
 *
 * Read-only. The helper scripts remain the way to write pages, and a viewer that could
 * half-edit them would be worse than one that plainly cannot.
 */
export function Wiki({ pages, page, loading, failed, onOpen, onBack, canGoBack, onClose }: WikiProps) {
  const tree = useMemo(() => (pages ? asTree(pages) : null), [pages]);
  const fields = useMemo(() => (page?.frontmatter ? readFrontmatter(page.frontmatter) : []), [page?.frontmatter]);
  /**
   * The body with its wikilinks rewritten as ordinary links.
   *
   * The renderer has never heard of `[[page]]`, and this wiki is written almost entirely in
   * them - 315 of them against 65 ordinary links - so leaving them would show most of its
   * cross-references as punctuation.
   */
  const body = useMemo(
    () => (page && pages ? withResolvedLinks(page.body, page.path, pages) : (page?.body ?? '')),
    [page, pages],
  );
  const title = pages?.find((each) => each.path === page?.path)?.title ?? page?.path ?? 'Wiki';

  /**
   * The gestures that already mean back, wherever the reader's hands are.
   *
   * A button alone makes retracing a trip to the header, and both of these are what a
   * reader moving through linked pages reaches for without thinking. The mouse's back
   * button has to be claimed on the way down as well: left alone the webview treats it as
   * navigation and leaves the app, which there is no way back from.
   */
  useEffect(() => {
    const goBack = () => {
      if (canGoBack) onBack();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
      }
    };

    // Buttons 3 and 4 are the thumb buttons. Claimed here so the webview does not navigate,
    // and acted on when the back one is released, which is when a click has happened.
    const claim = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) event.preventDefault();
    };

    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 3) return;
      event.preventDefault();
      goBack();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', claim);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', claim);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [canGoBack, onBack]);

  return (
    <>
      <header className="main-header">
        <h1>{title}</h1>
        <div className="header-row">
          {/* Named for where it goes rather than as "back", which the page history beside
              it also means: two buttons saying back would each be explaining the other. */}
          <button type="button" className="changes-action" onClick={onClose}>
            Sessions
          </button>
          {/* Disabled rather than absent, so the header does not move as the reader
              navigates. Both gestures above do the same thing. */}
          <button
            type="button"
            className="changes-action"
            onClick={onBack}
            disabled={!canGoBack}
            title="Back a page (Alt+Left, or the mouse's back button)"
          >
            ← Back
          </button>
          {page && <Breadcrumb path={page.path} pages={pages ?? []} onOpen={onOpen} />}
        </div>
      </header>

      {/* The row .main reserves for notices, kept even when there is nothing to say: the
          grid assigns its rows by position. */}
      <div className="notices">{failed && <p className="error">{failed}</p>}</div>

      <div className="wiki">
        <nav className="wiki-nav" aria-label="Wiki pages">
          {tree === null ? (
            <p className="wiki-empty">Reading the wiki…</p>
          ) : tree.folders.length === 0 && tree.pages.length === 0 ? (
            <p className="wiki-empty">No wiki on this machine.</p>
          ) : (
            <FolderBody folder={tree} openPath={page?.path ?? null} onOpen={onOpen} depth={0} />
          )}
        </nav>

        <article className="wiki-page-body">
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
        </article>
      </div>

      <div className="footer">
        <p className="changes-note">
          Read from {'~/.copilot/wiki'}. Read-only here: pages are written with the wiki scripts.
        </p>
      </div>
    </>
  );
}
