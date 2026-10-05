import { useEffect, useState } from 'react';

import type { WikiPage, WikiPageContent } from '../../shared/protocol';
import { NotesIcon } from './Icons';
import { WikiPageBody } from './WikiPageBody';

/**
 * A note from the wiki, beside the session it is about (#35).
 *
 * The browser replaces the whole pane, which is right for browsing and wrong for reading a
 * note about what is on screen: consulting one meant losing sight of the thing it explains.
 * This holds one page beside the transcript instead, with the session's own notes listed
 * above it and the browser one press away for anything wider than that.
 *
 * Not the whole browser in a column. The browser is itself a tree beside a page, and a tree
 * beside a page beside a transcript beside the sidebar is four columns of nothing readable.
 */
export function SessionNotes({
  notes,
  pages,
  page,
  loading,
  failed,
  saving,
  draft,
  onOpen,
  onEdit,
  onRevert,
  onSave,
  onBrowse,
  onClose,
}: {
  /** The pages this session's subject already has, which is what the picker lists. */
  notes: readonly WikiPage[];
  /** Every page there is, which is what a wikilink is resolved against. */
  pages: WikiPage[] | null;
  page: WikiPageContent | null;
  loading: boolean;
  failed: string | null;
  saving: boolean;
  /** What an editor holds for this page, or nothing when there are no unsaved edits. */
  draft: string | undefined;
  onOpen: (path: string) => void;
  onEdit: (path: string, source: string) => void;
  onRevert: (path: string) => void;
  onSave: (path: string) => void;
  /** Open the whole browser, for anything this column is too narrow to do. */
  onBrowse: () => void;
  onClose: () => void;
}) {
  /**
   * Whether the page is shown as the file it is.
   *
   * Per page, like the browser's: turning it on to fix a line and then reading the next
   * three pages as source is not what was asked for.
   */
  const [raw, setRaw] = useState(false);
  useEffect(() => setRaw(false), [page?.path]);

  const source = draft ?? page?.source ?? '';
  const dirty = draft !== undefined;
  /**
   * Which page is being read, which is not always one of this session's notes: a wikilink
   * followed out of one lands anywhere in the wiki, and the picker should not then claim
   * none of them is open.
   */
  const here = page?.path ?? null;

  // Saving from here as well as from the browser. The key should not stop meaning save
  // because the page is being read in a column rather than in a pane.
  useEffect(() => {
    if (!page || !dirty) return;

    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 's') return;
      event.preventDefault();
      onSave(page.path);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, dirty, onSave]);

  return (
    <aside className="notes" aria-label="Notes on this session">
      <header className="notes-head">
        <span className="notes-title">
          <span className="notes-mark" aria-hidden="true">
            <NotesIcon />
          </span>
          Notes
        </span>

        <span className="notes-actions">
          {dirty && page && (
            <>
              {/* No label saying "unsaved": two buttons offering to save or discard are
                  what having something unsaved looks like. */}
              <button type="button" className="changes-action" onClick={() => onRevert(page.path)} disabled={saving}>
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
          {page && (
            <button
              type="button"
              className={raw ? 'changes-action on' : 'changes-action'}
              onClick={() => setRaw((was) => !was)}
              aria-pressed={raw}
            >
              {raw ? 'Preview' : 'Raw'}
            </button>
          )}
          <button type="button" className="changes-action" onClick={onBrowse} title="Open the whole wiki">
            Browse
          </button>
          <button type="button" className="notes-close" onClick={onClose} aria-label="Close the notes">
            ×
          </button>
        </span>
      </header>

      {/* Only where there is a choice to make. One note and a list of one says nothing the
          page's own heading does not. */}
      {notes.length > 1 && (
        <nav className="notes-pages" aria-label="Which note to read">
          {notes.map((note) => (
            <button
              key={note.path}
              type="button"
              className={note.path === here ? 'notes-page on' : 'notes-page'}
              onClick={() => onOpen(note.path)}
              title={note.path}
              aria-current={note.path === here}
            >
              {note.title}
            </button>
          ))}
        </nav>
      )}

      {failed && <p className="error">{failed}</p>}

      <div className="notes-body">
        <WikiPageBody
          page={page}
          pages={pages}
          source={source}
          raw={raw}
          loading={loading}
          onEdit={onEdit}
          onOpen={onOpen}
          empty="Nothing open."
        />
      </div>
    </aside>
  );
}
