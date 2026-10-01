import { useCallback, useEffect, useRef, useState } from 'react';

import { activeSessions } from './sidecar';

/**
 * How often to look again.
 *
 * Nothing announces another Copilot starting or stopping, so this is the one thing in the
 * app that has to ask on a timer. Slow enough to be free - the whole check is a directory
 * scan and a signal apiece, measured at sixty milliseconds across two hundred sessions -
 * and quick enough that a terminal opened alongside is flagged before anybody has typed
 * much into it.
 */
const LOOK_EVERY_MS = 20_000;

/**
 * Which sessions some other Copilot has open (#63).
 *
 * Worth knowing because the app cannot stop it. Two Copilots in one conversation write to
 * the same log and the same database, and the loser is whichever wrote first - so the only
 * honest thing to do is say so and let the reader decide.
 *
 * Polled rather than watched. The marker is a file in the session's own folder, and
 * watching two hundred folders to catch a file that appears twice a day would cost far more
 * than looking occasionally.
 */
export function useActiveElsewhere() {
  const [active, setActive] = useState<string[]>([]);

  /** Dropped on unmount, so a late answer cannot set state on a gone component. */
  const watching = useRef(true);

  const look = useCallback(() => {
    void activeSessions()
      .then((found) => {
        if (watching.current) setActive(found);
      })
      // Nothing to say. This is a warning the reader never asked for, and failing to find
      // out costs them the warning rather than anything they were doing.
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    watching.current = true;
    look();

    const timer = setInterval(look, LOOK_EVERY_MS);
    return () => {
      watching.current = false;
      clearInterval(timer);
    };
  }, [look]);

  return { active, refresh: look };
}
