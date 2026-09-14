import { useCallback, useEffect, useRef, useState } from 'react';

import { addSessionDirectory, removeSessionDirectory, sessionDirectories } from './sidecar';

/**
 * The directories a session may reach beyond the one it works in, this app's `--add-dir`.
 *
 * Kept apart from the environment for the same reason the disabled skills are: the
 * environment is what exists on disk for a directory, and this is one session's grants
 * over it. Two sessions opened on the same directory share the first and not the second.
 *
 * Neither reading nor changing it resumes anything. A loaded session is told at once, and
 * a cold one takes the change with it when it next wakes.
 */
export function useDirectories(sessionId: string | null) {
  const [directories, setDirectories] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  /** A directory withdrawn from a session that still holds it until it next starts. */
  const [pending, setPending] = useState<string[]>([]);

  /** Which session the answer on its way belongs to, so a late one cannot land on another. */
  const asked = useRef<string | null>(null);

  useEffect(() => {
    asked.current = sessionId;
    setDirectories([]);
    setPending([]);
    setFailed(null);
    if (!sessionId) return;

    sessionDirectories(sessionId)
      .then((result) => {
        if (asked.current === sessionId) setDirectories(result.directories);
      })
      .catch((error: unknown) => {
        if (asked.current === sessionId) setFailed(String(error));
      });
  }, [sessionId]);

  const add = useCallback(
    (path: string) => {
      if (!sessionId) return;

      setFailed(null);
      return addSessionDirectory(sessionId, path)
        .then((result) => {
          if (asked.current !== sessionId) return;
          setDirectories(result.directories);
          // Granting back one that was withdrawn a moment ago settles the warning about it:
          // the session holds it either way, and now that is what was asked for.
          setPending((held) => held.filter((entry) => entry !== path));
        })
        .catch((error: unknown) => {
          if (asked.current === sessionId) setFailed(String(error));
        });
    },
    [sessionId],
  );

  const remove = useCallback(
    (path: string) => {
      if (!sessionId) return;

      setFailed(null);
      return removeSessionDirectory(sessionId, path)
        .then((result) => {
          if (asked.current !== sessionId) return;
          setDirectories(result.directories);
          if (result.untilRestart) setPending((held) => (held.includes(path) ? held : [...held, path]));
        })
        .catch((error: unknown) => {
          if (asked.current === sessionId) setFailed(String(error));
        });
    },
    [sessionId],
  );

  return { directories, pending, failed, add, remove };
}
