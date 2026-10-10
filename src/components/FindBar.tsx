import { useEffect, useRef } from 'react';

import { CloseIcon } from './Icons';

/**
 * Finding words inside the conversation on screen (#209).
 *
 * What every other reader on the machine offers: a box, a count, and a way to walk the hits.
 * The count is most of the answer - it says whether the word is worth walking at all.
 *
 * Drawn as the first row of the transcript and stuck to its top rather than added beside it.
 * The pane is a four-row grid whose rows are assigned by position, so a bar added there
 * would shift every row below it; and a bar inside the scrolling list is one the reader
 * cannot scroll away from by accident.
 *
 * @param said how many entries hold the words, which is what the count counts: rows rather
 *   than appearances, because a row is what the reader is taken to.
 */
export function FindBar({
  query,
  onQuery,
  said,
  at,
  onStep,
  onClose,
  openedAt,
}: {
  query: string;
  onQuery: (query: string) => void;
  said: number;
  /** Which hit the reader is on, counted from zero, or -1 before they have walked to one. */
  at: number;
  onStep: (by: 1 | -1) => void;
  onClose: () => void;
  /** Changes whenever the key is pressed again, which takes the keyboard back to the box. */
  openedAt: number;
}) {
  const field = useRef<HTMLInputElement>(null);

  /*
   * Taken on opening, and again on every press of the key that opens it - which is what a
   * reader pressing it a second time means: put me back in the box, and select what is
   * there so the next thing typed replaces it.
   */
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [openedAt]);

  const nothing = query.trim() !== '' && said === 0;

  return (
    <li className="find-bar">
      <input
        ref={field}
        type="text"
        className={nothing ? 'find-field empty' : 'find-field'}
        aria-label="Find in this session"
        placeholder="Find"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
            return;
          }
          // Escape belongs to the bar while the bar has the keyboard: the composer behind it
          // would otherwise clear what was being written, which is not what closing means.
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />

      {/* Says what it counts. The transcript holds what it has read rather than the whole
          session, so a bare number would be a claim about the conversation that is not true. */}
      <span className="find-count" role="status">
        {query.trim() === '' ? '' : said === 0 ? 'Nothing here' : `${at + 1} of ${said} shown`}
      </span>

      <button
        type="button"
        className="find-step"
        aria-label="Previous match"
        disabled={said === 0}
        onClick={() => onStep(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="find-step"
        aria-label="Next match"
        disabled={said === 0}
        onClick={() => onStep(1)}
      >
        ↓
      </button>
      <button type="button" className="find-step" aria-label="Close find" onClick={onClose}>
        <CloseIcon />
      </button>
    </li>
  );
}
