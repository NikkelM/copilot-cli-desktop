import { useCallback, useRef, useState } from 'react';

import { binnedSessions, purgeBinned, restoreBinned } from './sidecar';
import { explain } from './errors';
import type { BinnedSession } from '../../shared/protocol';

/**
 * What is waiting in the recycle bin, and the two things that can be done about it.
 *
 * Nothing is read until somebody asks. The bin is looked at rarely - when something was
 * deleted that should not have been - and a list nobody has opened is a directory listing
 * nobody needed.
 *
 * Restoring can refuse: a session of that id may already be there, which would be a live
 * session replaced by an older copy of itself. That is said rather than swallowed, since
 * the only other sign of it is a row that stays where it was.
 */
export function useRecycleBin(onRestored?: () => void, onError?: (message: string) => void) {
  const [binned, setBinned] = useState<BinnedSession[] | null>(null);

  const report = useRef(onError);
  report.current = onError;
  const wentBack = useRef(onRestored);
  wentBack.current = onRestored;

  const refresh = useCallback(() => {
    // Null while it is read, so the window can say it is reading rather than say the bin
    // is empty and then fill it.
    setBinned(null);
    void binnedSessions()
      .then(setBinned)
      // An empty list rather than nothing at all: a bin that cannot be read has nothing to
      // offer either way, and a window stuck reading for ever is worse than an empty one.
      .catch(() => setBinned([]));
  }, []);

  const restore = useCallback(
    (sessionId: string) => {
      void restoreBinned(sessionId)
        .then((went) => {
          // The session list is built from what is on disk, so it only learns about this
          // once something tells it to look again.
          if (went) wentBack.current?.();
          else report.current?.('A session with that id already exists. This one stayed in the recycle bin.');
        })
        .catch((e: unknown) => report.current?.(explain(e)))
        .finally(refresh);
    },
    [refresh],
  );

  const purge = useCallback(
    (sessionId: string) => {
      void purgeBinned(sessionId)
        .catch((e: unknown) => report.current?.(explain(e)))
        .finally(refresh);
    },
    [refresh],
  );

  return { binned, refresh, restore, purge };
}
