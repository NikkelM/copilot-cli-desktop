import { useCallback, useEffect, useState } from 'react';

import type { WikiPage } from '../../shared/protocol';

/**
 * Whether a note is open beside the session, and which session that was decided for (#35).
 *
 * Its own hook because the rule is worth being able to test: it lives in App otherwise,
 * where the only thing that would notice it breaking is somebody using the app.
 *
 * Closed again whenever the session changes, as the panels under the transcript are. A note
 * is open because of what the session is about, so carrying it across would be showing
 * somebody notes on a repository they have just navigated away from. Closed rather than
 * remembered per session for the same reason `usePanel` does not remember: the one rule is
 * enforceable, and a map of which sessions had it open is a thing to keep correct for ever.
 */
export function useNotesColumn(sessionId: string | null, notes: readonly WikiPage[], browsing = false) {
  const [wanted, setWanted] = useState(false);

  useEffect(() => setWanted(false), [sessionId]);

  const show = useCallback(() => setWanted(true), []);
  const hide = useCallback(() => setWanted(false), []);

  return {
    /**
     * Whether the column is actually drawn.
     *
     * Asked rather than stored, so the grid and the column cannot disagree - and so a
     * session whose notes have gone cannot leave an empty column behind.
     *
     * Stood down rather than closed while the whole browser is up: a note beside the wiki
     * is the wiki twice, and the browser is itself a tree beside a page. Closing it instead
     * meant going to the browser and coming back lost the column somebody had opened.
     */
    open: wanted && !browsing && notes.length > 0,
    show,
    hide,
  };
}
