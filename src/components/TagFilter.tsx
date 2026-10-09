import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * The tag a line above or below this one.
 *
 * Worked out from where the tags actually are rather than from how many fit on a line: they
 * wrap across however many the column allows, and that changes with the text size, with the
 * width somebody dragged the sidebar to, and with every name in the list.
 *
 * Lines are gathered by the tops they sit on. The nearest one across is what a reader means
 * by down - the tag under the one they were on, not the one that happens to come next in the
 * list. Wraps top to bottom, as every other list here does end to end.
 */
function aLineAway(all: HTMLElement[], from: number, by: 1 | -1): HTMLElement | undefined {
  const middle = (node: HTMLElement) => {
    const box = node.getBoundingClientRect();
    return box.left + box.width / 2;
  };
  const top = (node: HTMLElement) => Math.round(node.getBoundingClientRect().top);

  const here = all[from];
  if (!here) return undefined;

  const lines = [...new Set(all.map(top))].sort((a, b) => a - b);
  const at = lines.indexOf(top(here));
  const line = lines[(at + by + lines.length) % lines.length];
  if (line === undefined) return undefined;

  const wanted = middle(here);
  return all
    .filter((node) => top(node) === line)
    .reduce<HTMLElement | undefined>(
      (best, node) =>
        best === undefined || Math.abs(middle(node) - wanted) < Math.abs(middle(best) - wanted) ? node : best,
      undefined,
    );
}

/**
 * Narrow the list to sessions carrying every chosen tag.
 *
 * Beside the filter box rather than inside it. `tag:bug` works for someone who remembers the
 * name; this is for someone who does not, and who would otherwise have to read the list to
 * find out what they have been tagging (#123).
 *
 * Every chosen tag must be present, matching what the filter box does with terms: adding one
 * narrows. Narrowing to nothing is a real answer, and the empty list says so.
 */
export function TagFilter({
  known,
  chosen,
  onToggle,
  onClear,
}: {
  /** Every tag in use, with how many sessions carry it. Commonest first. */
  known: readonly { tag: string; count: number }[];
  chosen: readonly string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  /** The tags, as drawn, for the arrows and for knowing where the keyboard landed. */
  const chips = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('button.tag') ?? [])];

  useEffect(() => {
    // Opened by a press, so the keyboard has nowhere else to be: a list that appeared and
    // left the keyboard on the button behind it would have to be reached by Tab, which is
    // what opening it was meant to save.
    if (open) chips()[0]?.focus();
  }, [open]);

  /**
   * Left and right walk the tags one at a time; up and down move a line.
   *
   * The tags wrap across however many lines the column allows, so down is not the next tag -
   * it is the one below, which depends entirely on where they happened to break. Tab is left
   * alone and walks them one at a time too.
   */
  function onKeyDown(event: ReactKeyboardEvent) {
    const all = chips();
    const from = all.indexOf(document.activeElement as HTMLButtonElement);
    if (from === -1) return;

    const along = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (along !== 0) {
      event.preventDefault();
      // Wrapping, as the other menus in the app do.
      all[(from + along + all.length) % all.length]?.focus();
      return;
    }

    const down = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (down === 0) return;

    event.preventDefault();
    aLineAway(all, from, down)?.focus();
  }

  useEffect(() => {
    if (!open) return;

    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  // Nothing to choose from until something has been tagged, and a button that opens an empty
  // list is a button that says the feature is broken.
  if (known.length === 0) return null;

  return (
    <div className="tag-filter" ref={box}>
      <button
        type="button"
        className={chosen.length > 0 ? 'tag-filter-button on' : 'tag-filter-button'}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((showing) => !showing)}
        aria-label={chosen.length > 0 ? `Filtering by ${chosen.join(', ')}` : 'Filter by tag'}
        data-tip={chosen.length > 0 ? `Filtering by ${chosen.join(', ')}` : 'Filter by tag'}
      >
        Tags
        {chosen.length > 0 && <span className="tag-filter-count">{chosen.length}</span>}
      </button>

      {open && (
        <div className="tag-filter-menu" role="group" aria-label="Filter by tag" onKeyDown={onKeyDown}>
          <ul className="tag-list" ref={list}>
            {known.map(({ tag, count }) => (
              <li key={tag}>
                <button
                  type="button"
                  className={chosen.includes(tag) ? 'tag on' : 'tag'}
                  aria-pressed={chosen.includes(tag)}
                  onClick={() => onToggle(tag)}
                >
                  {tag}
                  <span className="tag-count">{count}</span>
                </button>
              </li>
            ))}
          </ul>

          {chosen.length > 0 && (
            <button type="button" className="tag-filter-clear" onClick={onClear}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
