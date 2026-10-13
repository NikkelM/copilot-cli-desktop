import { useEffect, useMemo, useRef, useState } from 'react';

import type { SessionPrompt } from '../../shared/protocol';
import { formatRelative } from '../lib/time';

interface PromptPickerProps {
  /** Every prompt in the session, newest first, or null until they have been asked for. */
  prompts: SessionPrompt[] | null;
  /** Why they could not be read, if they could not. */
  failed: string | null;
  /** Ask for them. Costs a read of the whole log, so it waits for the picker to open. */
  onOpen: () => void;
  onChoose: (prompt: SessionPrompt) => void;
  /** The one this list last sent the reader to, so it says where you are as well as where to go. */
  at: string | null;
}

/**
 * How many rows are drawn at a time.
 *
 * A long session has thousands of these - 2,050 on the largest log here - and a dropdown
 * holding all of them is a dropdown nobody can scroll. More arrive on reaching the bottom,
 * so this bounds what is laid out at once rather than what can be reached.
 */
const PAGE = 200;

/** How close to the bottom asks for the next page, matching what the transcript uses at its top. */
const NEXT_PAGE_THRESHOLD_PX = 120;

/**
 * The prompts of a session, to navigate it by.
 *
 * A dropdown rather than a panel, because navigation is transient: you open it, choose, and
 * it closes. A panel under the transcript would take height from the very thing being
 * navigated and then stay there.
 *
 * Newest first, like every other list of things that happened here. The transcript reads the
 * other way, but this is not a second transcript - it is a way back to a moment, and the
 * moment somebody wants is far more often a recent one.
 */
export function PromptPicker({ prompts, failed, onOpen, onChoose, at }: PromptPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  /** How many of the matches are laid out, which grows as the list is scrolled. */
  const [drawn, setDrawn] = useState(PAGE);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);

    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  // The keyboard goes to the filter, since narrowing is what anybody opening this does next.
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const matching = useMemo(() => {
    const wanted = filter.trim().toLowerCase();
    const all = prompts ?? [];
    return wanted ? all.filter((prompt) => prompt.text.toLowerCase().includes(wanted)) : all;
  }, [prompts, filter]);

  // Narrowing puts a different list under the reader, and they are back at the top of it.
  useEffect(() => setDrawn(PAGE), [filter]);

  const shown = matching.slice(0, drawn);

  /**
   * Reaching the bottom draws the next page.
   *
   * Grown rather than asked for, since every prompt is already in hand: what the page bounds
   * is the laying out, which is the part that costs on a list of thousands. Short of the
   * bottom rather than at it, so the rows are there before the scroll arrives.
   */
  function onScroll(event: React.UIEvent<HTMLDivElement>) {
    const list = event.currentTarget;
    if (list.scrollHeight - list.scrollTop - list.clientHeight > NEXT_PAGE_THRESHOLD_PX) return;

    // Stopping at the end draws nothing different - `slice` bounds it either way - so no
    // test can tell this from growing for ever. What it saves is a state change, and so a
    // render of the whole list, on every scroll event once there is nothing left to add.
    setDrawn((count) => (count < matching.length ? count + PAGE : count));
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }

    setOpen(true);
    setFilter('');
    setDrawn(PAGE);
    // Reading the whole log is not free, so it waits for somebody to actually want the list.
    onOpen();
  }

  function pick(prompt: SessionPrompt) {
    onChoose(prompt);
    setOpen(false);
  }

  /** Down out of the box walks the rows, which is what a list under a filter is for. */
  function onFilterKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'Enter') return;

    event.preventDefault();
    if (event.key === 'Enter') {
      const first = shown[0];
      if (first) pick(first);
      return;
    }

    box.current?.querySelector<HTMLButtonElement>('.prompt-row')?.focus();
  }

  /** Up and down walk the rows; up off the top goes back to the filter. */
  function onRowKey(event: React.KeyboardEvent<HTMLElement>) {
    const by = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (by === 0) return;

    event.preventDefault();
    const rows = [...(box.current?.querySelectorAll<HTMLButtonElement>('.prompt-row') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index === 0 && by === -1) {
      field.current?.focus();
      return;
    }

    rows[Math.min(rows.length - 1, Math.max(0, index + by))]?.focus();
  }

  return (
    <div className="prompts" ref={box}>
      <button
        type="button"
        className="prompts-current"
        onClick={toggle}
        aria-expanded={open}
        title="Go to a prompt in this session"
      >
        Prompts
        {prompts && <span className="prompts-count">{prompts.length}</span>}
      </button>

      {open && (
        <div className="prompts-menu">
          <input
            ref={field}
            type="search"
            className="prompts-filter"
            placeholder="Filter prompts"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={onFilterKey}
            aria-label="Filter prompts"
          />

          {failed && <p className="error">{failed}</p>}
          {!prompts && !failed && <p className="prompts-loading">Reading the session.</p>}

          {prompts && matching.length === 0 && (
            <p className="prompts-loading">{prompts.length === 0 ? 'Nothing asked yet.' : 'No prompt says that.'}</p>
          )}

          <div className="prompts-list" role="listbox" aria-label="Prompts" onKeyDown={onRowKey} onScroll={onScroll}>
            {shown.map((prompt) => (
              <button
                type="button"
                key={prompt.at}
                role="option"
                aria-selected={prompt.at === at}
                className={prompt.at === at ? 'prompt-row chosen' : 'prompt-row'}
                onClick={() => pick(prompt)}
              >
                <span className="prompt-row-text">{prompt.text}</span>
                <span className="prompt-row-when">{formatRelative(prompt.at)}</span>
              </button>
            ))}
            {/* Inside the list rather than under it, so it is what the scroll arrives at and
                the reader sees why there is a pause before the next rows appear. */}
            {matching.length > shown.length && (
              <p className="prompts-loading">{matching.length - shown.length} older</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
