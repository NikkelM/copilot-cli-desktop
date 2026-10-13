import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionPrompt } from '../../shared/protocol';
import { sessionPrompts } from './sidecar';
import { messageOf } from './errors';

/**
 * The prompts of a session, read once and only when asked for (#96).
 *
 * Reading them means reading the whole log, which is a second on the largest here, so
 * nothing asks until somebody opens the list. Held afterwards: a reader navigating a long
 * conversation opens this repeatedly, and paying that second each time would make the list
 * feel broken.
 *
 * Read again when the session has said something since, rather than on a timer. `since` is
 * whatever the caller already watches for that - how many events are loaded will do - so a
 * list opened after a reply has the prompt that produced it.
 */
export function usePromptList(sessionId: string | null, since: number) {
  const [prompts, setPrompts] = useState<SessionPrompt[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Where this list last sent the reader, so it says where you are as well as where to go. */
  const [at, setAt] = useState<string | null>(null);
  /** What the session had said when the list was read, so a stale one is read again. */
  const read = useRef<number | null>(null);
  /**
   * Which session the read belongs to, so a late answer cannot land on another.
   *
   * This read is the slowest in the app - a second on the largest log here - which makes it
   * the one most likely to come back after the reader has moved on. Another session's
   * prompts would be read as this one's, and choosing from them would jump this session to
   * wherever a moment from a different log happened to fall.
   */
  const asking = useRef<string | null>(null);
  asking.current = sessionId;

  // A list belongs to the session it was read from, and none of it survives moving on.
  useEffect(() => {
    setPrompts(null);
    setFailed(null);
    setAt(null);
    read.current = null;
  }, [sessionId]);

  const load = useCallback(() => {
    if (!sessionId || read.current === since) return;

    const forSession = sessionId;
    read.current = since;
    setFailed(null);
    sessionPrompts(forSession)
      .then((found) => {
        if (asking.current === forSession) setPrompts(found);
      })
      .catch((error: unknown) => {
        if (asking.current !== forSession) return;
        // Askable again, since a read that failed is not an answer.
        read.current = null;
        setFailed(messageOf(error));
      });
  }, [sessionId, since]);

  return { prompts, failed, at, load, went: setAt };
}
