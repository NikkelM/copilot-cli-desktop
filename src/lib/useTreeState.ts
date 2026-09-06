import { useCallback, useEffect, useRef, useState } from 'react';

import { gitState } from './sidecar';
import type { TreeState } from '../../shared/protocol';

/**
 * Which branch a session's directory is on, and whether its tree is clean.
 *
 * Asked for when the session is opened and again when a turn ends, rather than on a timer:
 * the agent working is what changes the answer, and the app already knows when that
 * happens. A status walk is cheap but not free on a large repository, so it is not run
 * because something re-rendered.
 */
export function useTreeState(cwd: string | null) {
  const [state, setState] = useState<TreeState | null>(null);

  // Held in a ref so the refresh below keeps one identity: it is handed to an event
  // subscription that is registered once and would otherwise hold the first cwd forever.
  const showing = useRef(cwd);
  showing.current = cwd;

  const load = useCallback((directory: string | null) => {
    if (!directory) {
      setState(null);
      return;
    }

    gitState(directory)
      .then((found) => {
        // A reply for a directory the reader has since navigated away from describes
        // somewhere they are no longer looking.
        if (showing.current === directory) setState(found);
      })
      .catch(() => showing.current === directory && setState(null));
  }, []);

  useEffect(() => {
    // Cleared rather than left in place: the previous session's branch beside this one's
    // path would be worse than showing nothing for a moment.
    setState(null);
    load(cwd);
  }, [cwd, load]);

  return { state, refresh: useCallback(() => load(showing.current), [load]) };
}
