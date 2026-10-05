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
 * Opens the first of them in the column beside the transcript, and closes it again. Not a
 * list: which note to read is a choice worth offering where there is room for the titles,
 * which is the column itself rather than a header already holding a path and a branch.
 */
export function HeaderNotes({
  pages,
  open = false,
  onOpen,
}: {
  pages: readonly WikiPage[];
  /** Whether the column is showing, so the control can say so and close it again. */
  open?: boolean;
  onOpen: (page: string) => void;
}) {
  const first = pages[0];
  if (!first) return null;
  return (
    <button
      type="button"
      className={open ? 'header-notes on' : 'header-notes'}
      onClick={() => onOpen(first.path)}
      aria-pressed={open}
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
