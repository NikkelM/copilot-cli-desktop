import { useCallback, useEffect, useRef, useState } from 'react';

/** The modifiers a click carried, which is what decides whether it marks or selects. */
export interface ClickKeys {
  /** Ctrl on Windows and Linux, Command on a Mac: add this one to what is marked. */
  toggle: boolean;
  /** Shift: mark everything between the last one and this one. */
  range: boolean;
}

/**
 * The sessions picked out to be acted on together (#63).
 *
 * Deliberately not the same thing as the session being read. One session is open at a time
 * and that is what the transcript shows; marking is about a set of rows that something is
 * going to happen to, and the two answer different questions - which is why a marked
 * session is drawn differently from the open one rather than looking like a second kind of
 * selected.
 *
 * Ctrl and Shift, because that is what every list on the machine does and nobody has to be
 * told. No checkbox column: it would take room from the titles on every row for the sake of
 * a gesture used on a handful of days, and the rows are already as narrow as they read.
 *
 * @param listed every session that could be marked, for forgetting the ones that leave
 */
export function useMarked(listed: readonly string[]) {
  const [marked, setMarked] = useState<readonly string[]>([]);

  /** Where a range starts: the last row touched without Shift. */
  const anchor = useRef<string | null>(null);

  /**
   * Forget anything that has gone.
   *
   * A marked session can be deleted, archived out of the list, or filtered away while the
   * marks stand. Acting on one that is no longer there would be acting on nothing, and the
   * count above the list would be describing rows nobody can see.
   */
  useEffect(() => {
    setMarked((current) => {
      const kept = current.filter((id) => listed.includes(id));
      return kept.length === current.length ? current : kept;
    });
  }, [listed]);

  /**
   * What a click on a row means.
   *
   * Returns whether the click was handled as marking. A plain click is not: it belongs to
   * whatever opens a session, and saying so here keeps that decision in one place.
   *
   * The order comes with the click rather than with the hook, because only the thing
   * drawing the list knows it. The sidebar groups sessions - favourites, in memory, the
   * rest - and folds groups away, so the rows between two others on screen are nothing like
   * the rows between them in the list this was handed. Measured as a bug: a range across
   * five favourites also marked two sessions from the group below it.
   *
   * @param order the sessions as they are drawn, top to bottom, folded ones left out
   */
  const click = useCallback((sessionId: string, keys: ClickKeys, order: readonly string[]): boolean => {
    if (keys.range && anchor.current) {
      const from = order.indexOf(anchor.current);
      const to = order.indexOf(sessionId);
      if (from !== -1 && to !== -1) {
        const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        // Added to what is already marked rather than replacing it, so several ranges can
        // be gathered - which is what holding Shift after a Ctrl-click means everywhere
        // else.
        setMarked((current) => [...current, ...span.filter((id) => !current.includes(id))]);
        return true;
      }
    }

    if (keys.toggle) {
      anchor.current = sessionId;
      setMarked((current) =>
        current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId],
      );
      return true;
    }

    // An ordinary click is about going somewhere, and arriving somewhere ends whatever was
    // being gathered.
    anchor.current = sessionId;
    setMarked([]);
    return false;
  }, []);

  const clear = useCallback(() => setMarked([]), []);

  return { marked, click, clear };
}
