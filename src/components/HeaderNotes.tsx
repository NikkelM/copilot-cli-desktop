import type { WikiPage } from '../../shared/protocol';
import { NotesIcon } from './Icons';

/**
 * How many notes the open session's repository already has (#35).
 *
 * Silent where there are none, which is most sessions. Unlike the tags beside it there is
 * nothing to add here - a wiki page is written in the wiki - so a control offering to make
 * one would be a button that leaves the app, and an empty one would be a label saying no
 * four times a day.
 *
 * Opens the wiki at the first of them rather than listing them here. The browser is one
 * press away and already does searching, trees and reading; this only has to say that there
 * is something to find, which is the part nobody would otherwise discover.
 */
export function HeaderNotes({ pages, onOpen }: { pages: readonly WikiPage[]; onOpen: (page: string) => void }) {
  const first = pages[0];
  if (!first) return null;

  return (
    <button
      type="button"
      className="header-notes"
      onClick={() => onOpen(first.path)}
      title={
        pages.length === 1
          ? `Your notes on this repository: ${first.title}`
          : `${pages.length} pages in your wiki about this repository`
      }
    >
      <span className="header-notes-mark" aria-hidden="true">
        <NotesIcon />
      </span>
      {pages.length === 1 ? '1 note' : `${pages.length} notes`}
    </button>
  );
}
