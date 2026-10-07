import { useCallback, useRef, useState } from 'react';

import type { QueuedItem } from '../../shared/protocol';

import { sessionQueue, clearQueued, editQueued, moveQueued, removeQueued } from './sidecar';

/**
 * What each session has waiting behind the turn it is running.
 *
 * Read from the runtime, not kept here. This app used to track it by hand, on the stated
 * belief that the runtime offered no way to ask - it does, and a second copy of a queue can
 * only ever disagree with the first. Reading it also picks up everything this app did not
 * put there: commands queued during a turn, model changes, and messages sent from a
 * terminal attached to the same session.
 *
 * `pending_messages.modified` carries no payload, which is what made the runtime queue look
 * unreadable. It is a prompt to ask again, and asking is cheap: an unloaded session answers
 * with nothing without being resumed.
 */
export function useQueue() {
  const [queues, setQueues] = useState<Record<string, QueuedItem[]>>({});

  /**
   * Reads already in flight, per session.
   *
   * The runtime announces every change, and a turn taking three queued messages announces
   * three in quick succession. Without this each would start its own read and they would
   * land in whatever order the round trips finished in, leaving the queue showing a state
   * it had already moved past.
   */
  const reading = useRef(new Map<string, number>());

  const refresh = useCallback((sessionId: string) => {
    const at = (reading.current.get(sessionId) ?? 0) + 1;
    reading.current.set(sessionId, at);

    sessionQueue(sessionId)
      .then((items) => {
        // A later read has already been asked for, so this answer is the older one.
        if (reading.current.get(sessionId) !== at) return;
        setQueues((current) => {
          const previous = current[sessionId];
          // Both empty is the common answer, and replacing one empty list with another
          // would rerender the sidebar on every announcement.
          if (!previous?.length && !items.length) return current;
          return { ...current, [sessionId]: items };
        });
      })
      // A queue that cannot be read is a queue nobody can act on, and saying so in the
      // error bar would bury a real message under the noise of a session going away.
      .catch(() =>
        setQueues((current) => (current[sessionId]?.length ? { ...current, [sessionId]: [] } : current)),
      );
  }, []);

  /**
   * Forget what a session had waiting, without asking.
   *
   * For a session being let go: it is gone before the answer could come back, and the
   * runtime that held the queue went with it.
   */
  const clear = useCallback((sessionId: string) => {
    reading.current.delete(sessionId);
    setQueues((current) => (current[sessionId]?.length ? { ...current, [sessionId]: [] } : current));
  }, []);

  /**
   * Changing your mind about something already waiting (#76).
   *
   * Each asks the runtime and then reads the queue back, rather than editing the copy held
   * here. The runtime owns it and is consuming from it as the turn runs, so the answer to
   * "what is waiting now" is only ever its own - and an entry taken by the turn while the
   * call was in flight has to show as gone, not as having failed to move.
   */
  const act = useCallback(
    async (sessionId: string, go: () => Promise<boolean>) => {
      try {
        await go();
      } finally {
        refresh(sessionId);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    (sessionId: string, id: string) => act(sessionId, () => removeQueued(sessionId, id)),
    [act],
  );
  const edit = useCallback(
    (sessionId: string, id: string, text: string) => act(sessionId, () => editQueued(sessionId, id, text)),
    [act],
  );
  const move = useCallback(
    (sessionId: string, id: string, to: number) => act(sessionId, () => moveQueued(sessionId, id, to)),
    [act],
  );
  const empty = useCallback((sessionId: string) => act(sessionId, () => clearQueued(sessionId)), [act]);

  return { queues, refresh, clear, remove, edit, move, empty };
}