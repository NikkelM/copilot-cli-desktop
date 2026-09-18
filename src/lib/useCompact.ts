import { useCallback, useState } from 'react';

/** Where the choice lives, beside the other things the sidebar remembers about itself. */
const COMPACT = 'copilot-desktop.compact';

function read(): boolean {
  try {
    return localStorage.getItem(COMPACT) === 'true';
  } catch {
    return false;
  }
}

/**
 * How much of each session row is drawn.
 *
 * A row carries a title, a time and repository, and two lines of what was last said. The
 * last of those is what finding a half-remembered session needs, and most of the height
 * once you already know which one you want (#188).
 *
 * One setting for the whole list. A state per row was written first and taken out again:
 * it put a second control on every row, a second thing to explain, and a record that grew
 * with the session list - for a choice nobody makes about one session. The time and the
 * repository stay on a short row, so what a collapse drops is only the quotation.
 */
export function useCompact() {
  const [compact, setCompact] = useState(read);

  const toggleAll = useCallback(() => {
    setCompact((current) => {
      const next = !current;
      try {
        localStorage.setItem(COMPACT, String(next));
      } catch {
        // It still works for this run; only remembering it does not.
      }
      return next;
    });
  }, []);

  return { compact, toggleAll };
}
