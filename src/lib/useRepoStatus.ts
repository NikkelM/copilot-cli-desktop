import { useCallback, useEffect, useRef, useState } from 'react';

import { gitStatus } from './sidecar';
import type { RepoStatus } from '../../shared/protocol';

/**
 * The state of the session's repository, for the source control panel.
 *
 * Read when the panel is opened and again when a turn records changes, rather than on a
 * timer: what changes the answer is the agent working or the reader editing, and the app
 * already knows about the first. A status walk is cheap but not free on a large repository,
 * so it does not run because something re-rendered (#42).
 *
 * Null covers both a directory outside a repository and one that could not be read, because
 * the panel does the same thing for each: says there is nothing to show. A session in a
 * plain folder is an ordinary session, not an error.
 */
export function useRepoStatus(cwd: string | null, open: boolean) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [loading, setLoading] = useState(false);
  /** Which directory is being shown, so a slow reply for another cannot land here. */
  const showing = useRef(cwd);
  showing.current = cwd;

  const load = useCallback(() => {
    const directory = showing.current;
    if (!directory) {
      setStatus(null);
      return;
    }

    setLoading(true);
    gitStatus(directory)
      .then((found) => {
        if (showing.current === directory) setStatus(found);
      })
      .catch(() => {
        if (showing.current === directory) setStatus(null);
      })
      .finally(() => {
        if (showing.current === directory) setLoading(false);
      });
  }, []);

  useEffect(() => {
    // Cleared rather than left behind: another repository's files under this session's name
    // would be worse than an empty panel for a moment.
    setStatus(null);
    if (open && cwd) load();
  }, [cwd, open, load]);

  return { status, loading, refresh: load };
}




