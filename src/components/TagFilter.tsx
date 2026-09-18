import { useEffect, useRef, useState } from 'react';

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
        title={chosen.length > 0 ? `Filtering by ${chosen.join(', ')}` : 'Filter by tag'}
      >
        Tags
        {chosen.length > 0 && <span className="tag-filter-count">{chosen.length}</span>}
      </button>

      {open && (
        <div className="tag-filter-menu" role="group" aria-label="Filter by tag">
          <ul className="tag-list">
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
