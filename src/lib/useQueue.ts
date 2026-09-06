import { useCallback, useState } from 'react';

/** A message waiting for the turn in front of it to finish. */
export interface QueuedMessage {
  /** The id the runtime gave it, which the `user.message` event carries when it is taken. */
  id: string;
  prompt: string;
}

/**
 * What each session has waiting behind the turn it is running.
 *
 * Kept here rather than read from the runtime because the runtime does not offer it: the
 * `pending_messages.modified` event says only that the queue changed, with no payload, and
 * the session exposes no way to ask. What it does give is an id when a message is accepted
 * and the same id on the `user.message` event when it is finally taken, which is enough to
 * follow a message exactly rather than by matching its text.
 */
export function useQueue() {
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});

  /** Record a message the runtime accepted but has not started yet. */
  const add = useCallback((sessionId: string, message: QueuedMessage) => {
    setQueues((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), message] }));
  }, []);

  /**
   * Drop a message that has left the queue for the conversation.
   *
   * Every message arrives this way, queued or not, so an id that was never queued is
   * expected and means nothing needs to change.
   */
  const taken = useCallback((sessionId: string, messageId: string) => {
    setQueues((current) => {
      const waiting = current[sessionId];
      if (!waiting?.some((message) => message.id === messageId)) return current;

      return { ...current, [sessionId]: waiting.filter((message) => message.id !== messageId) };
    });
  }, []);

  /**
   * Forget everything a session had waiting.
   *
   * Stopping a turn discards the queue behind it, and so does letting the session go, so
   * anything still shown would be waiting for something that will never happen.
   */
  const clear = useCallback((sessionId: string) => {
    setQueues((current) => (current[sessionId]?.length ? { ...current, [sessionId]: [] } : current));
  }, []);

  return { queues, add, taken, clear };
}
