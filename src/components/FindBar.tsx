import { useEffect, useRef } from 'react';

import { CloseIcon, TickIcon } from './Icons';

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
  searchAll,
  onSearchAll,
  reaching,
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
  /** Whether the find reaches back for the rest of the session rather than what is held. */
  searchAll: boolean;
  onSearchAll: (on: boolean) => void;
  /** Whether it is still reaching, so the count is not the whole answer yet. */
  reaching: boolean;
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

  const nothing = query.trim() !== '' && said === 0 && !reaching;

  /**
   * What the count can honestly claim.
   *
   * While it is still reaching back, what it has is a floor rather than a total. Once it has
   * everything, the session is the answer; with the reach turned off, the page is - and the
   * page is not the session, so it says which it means.
   */
  const counted =
    query.trim() === ''
      ? ''
      : reaching
        ? `${Math.max(at + 1, 0)} of ${said} so far`
        : said === 0
          ? 'Nothing here'
          : `${at + 1} of ${said}${searchAll ? '' : ' shown'}`;

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
          session, so a bare number would be a claim that is not true until it has the rest. */}
      <span className="find-count" role="status">
        {counted}
      </span>

      {/* Drawn the way the settings boxes are, which is the only checkbox style this app has. */}
      <label className="find-all" title="Reach back through the whole session, not only what is loaded">
        <span className="tickbox">
          <input
            type="checkbox"
            checked={searchAll}
            onChange={() => onSearchAll(!searchAll)}
            onKeyDown={(event) => {
              // A box answers Space and nothing else, which is a surprise beside controls
              // that answer Enter either side of it.
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onSearchAll(!searchAll);
            }}
          />
          <TickIcon />
        </span>
        Everything
      </label>

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
