import { useCallback, useState } from 'react';

import { sessionDiskUsage } from './sidecar';
import type { SessionDisk } from '../../shared/protocol';

/**
 * What every session is using on disk.
 *
 * Nothing is read until somebody asks. The walk covers every session directory there has
 * ever been - 753 of them here - and a sidebar that never shows a size should not pay for
 * one on every refresh.
 *
 * Kept after it has been read, unlike the recycle bin, which empties itself so the window
 * can say it is reading. Nothing in the app changes these numbers while the window is open:
 * deleting a session moves it to the bin, which is somewhere else on the same disk.
 */
export function useDiskUsage() {
  const [usage, setUsage] = useState<SessionDisk[] | null>(null);
  const [reading, setReading] = useState(false);

  const refresh = useCallback(() => {
    setReading(true);
    void sessionDiskUsage()
      // An empty list rather than nothing at all: a walk that failed has nothing to offer
      // either way, and a window stuck reading for ever is worse than an empty one.
      .then(setUsage, () => setUsage([]))
      .finally(() => setReading(false));
  }, []);

  return { usage, reading, refresh };
}

/**
 * What the sessions come to altogether, which is the number the question is really about.
 *
 * Counted over everything rather than over what is shown, since a list of the largest ten
 * would otherwise say a total that matches nothing anybody can see.
 */
export function totalBytes(usage: readonly SessionDisk[]): number {
  return usage.reduce((total, session) => total + session.bytes, 0);
}
