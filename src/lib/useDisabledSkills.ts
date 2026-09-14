import { useCallback, useEffect, useRef, useState } from 'react';

import { disabledSkills, setSkillEnabled } from './sidecar';

/**
 * Which skills this session has been told not to load.
 *
 * Kept apart from the environment itself because the two answer different questions and
 * change at different times: the environment is what exists on disk for this directory, and
 * this is one session's choices about it. The same directory opened on two sessions shares
 * the first and not the second.
 *
 * Neither reading nor changing it resumes anything. The set belongs to the app, and the
 * sidecar hands it to the runtime whenever the session is next started, so a session that
 * is cold takes the change with it when it wakes.
 */
export function useDisabledSkills(sessionId: string | null) {
  const [disabled, setDisabled] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);

  /** Which session the answer on its way belongs to, so a late one cannot land on another. */
  const asked = useRef<string | null>(null);

  useEffect(() => {
    asked.current = sessionId;
    setDisabled([]);
    setFailed(null);
    if (!sessionId) return;

    disabledSkills(sessionId)
      .then((result) => {
        if (asked.current === sessionId) setDisabled(result.disabled);
      })
      .catch((error: unknown) => {
        if (asked.current === sessionId) setFailed(String(error));
      });
  }, [sessionId]);

  const toggle = useCallback(
    (name: string, enabled: boolean) => {
      if (!sessionId) return;

      setFailed(null);
      return setSkillEnabled(sessionId, name, enabled)
        .then((result) => {
          // The sidecar returns the whole set rather than the change, so the answer replaces
          // what is held instead of being merged into it. Two switches in flight at once
          // therefore settle on whichever finished last, which is also what happened on disk.
          if (asked.current === sessionId) setDisabled(result.disabled);
        })
        .catch((error: unknown) => {
          if (asked.current === sessionId) setFailed(String(error));
        });
    },
    [sessionId],
  );

  return { disabled, failed, toggle };
}
