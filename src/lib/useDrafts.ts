import { useCallback, useRef, useState } from 'react';

/**
 * Unsent text, per session, and the one prompt each may have set aside.
 *
 * Two records rather than one because they are two states of the same writing, and every
 * operation moves text between them. Held together for that reason: a stash that lived
 * apart from the drafts it swaps with would need both to be passed around anyway.
 *
 * Per session throughout. A draft kept in the composer would follow the reader to whichever
 * session they opened next and be sent there instead, which is #83.
 */
export function useDrafts() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [stash, setStash] = useState<Record<string, string>>({});

  // Read by handlers registered once, which would otherwise hold the first render's answer.
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  const stashNow = useRef(stash);
  stashNow.current = stash;

  /** Replace what a session has written but not sent. */
  const write = useCallback((sessionId: string, text: string) => {
    setDrafts((current) => ({ ...current, [sessionId]: text }));
  }, []);

  /**
   * Offer text only if the box is empty.
   *
   * Used to hand a failed message back. Anything typed since wins: taking that away to
   * restore an older draft would be the worse theft.
   */
  const suggest = useCallback((sessionId: string, text: string) => {
    setDrafts((current) => (current[sessionId] ? current : { ...current, [sessionId]: text }));
  }, []);

  /**
   * Trade the box with the session's one stash slot.
   *
   * A swap rather than a push, because with one slot stashing over something already
   * stashed would throw it away - and a key whose job is not to lose writing has no
   * business losing any. So an empty box pops, a full one stashes, and both full trade.
   */
  const swap = useCallback((sessionId: string) => {
    const box = draftsNow.current[sessionId] ?? '';
    const held = stashNow.current[sessionId] ?? '';
    if (!box && !held) return;

    setDrafts((current) => ({ ...current, [sessionId]: held }));
    setStash((current) => ({ ...current, [sessionId]: box }));
  }, []);

  return {
    /** What is in a session's box, for the composer to show. */
    textOf: (sessionId: string | null) => (sessionId && drafts[sessionId]) || '',
    /** Whether a session has a prompt set aside, which the composer says so it is not invisible. */
    hasStash: (sessionId: string | null) => Boolean(sessionId && stash[sessionId]),
    /** What is in a session's box right now, for a handler that was registered once. */
    written: useCallback((sessionId: string | null) => (sessionId && draftsNow.current[sessionId]) || '', []),
    write,
    clear: useCallback((sessionId: string) => write(sessionId, ''), [write]),
    suggest,
    swap,
  };
}
