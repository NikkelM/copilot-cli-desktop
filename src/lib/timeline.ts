import type { TranscriptEvent } from '../../shared/protocol';

/** A transcript event, or one the app invented before the runtime confirmed it. */
export type TimelineEvent = TranscriptEvent & { local?: boolean };

export function contentOf(event: TranscriptEvent): string | null {
  const data = event.data as { content?: unknown } | null;
  return typeof data?.content === 'string' ? data.content : null;
}

function messageIdOf(event: TranscriptEvent): string | null {
  const data = event.data as { messageId?: unknown } | null;
  return typeof data?.messageId === 'string' ? data.messageId : null;
}

function reasoningIdOf(event: TranscriptEvent): string | null {
  const data = event.data as { reasoningId?: unknown } | null;
  return typeof data?.reasoningId === 'string' ? data.reasoningId : null;
}

function deltaOf(event: TranscriptEvent): string {
  const data = event.data as { deltaContent?: unknown } | null;
  return typeof data?.deltaContent === 'string' ? data.deltaContent : '';
}

/**
 * Add an event arriving from a live session to the events seen since it was selected.
 *
 * A prompt is shown optimistically so it appears the moment it is sent, and the runtime
 * echoes the same message back a beat later. The echo replaces the optimistic entry
 * rather than following it, which would show the prompt twice.
 *
 * A reply arrives as a run of deltas and then once more in full. Each is folded into the
 * one before it, so a long answer is a single growing event rather than hundreds that
 * every later render would have to walk, and the full message replaces the run it
 * completes rather than repeating it.
 */
export function appendLive(current: TimelineEvent[], event: TimelineEvent): TimelineEvent[] {
  if (event.type === 'user.message') {
    const index = current.findIndex(
      (entry) => entry.local && entry.type === 'user.message' && contentOf(entry) === contentOf(event),
    );
    if (index !== -1) {
      const next = [...current];
      next[index] = event;
      return next;
    }
  }

  const messageId = messageIdOf(event);
  if (messageId && (event.type === 'assistant.message_delta' || event.type === 'assistant.message')) {
    const index = current.findIndex(
      (entry) => entry.type === 'assistant.message_delta' && messageIdOf(entry) === messageId,
    );
    if (index !== -1) {
      const next = [...current];
      next[index] =
        event.type === 'assistant.message'
          ? event
          : { ...event, data: { messageId, deltaContent: deltaOf(next[index]!) + deltaOf(event) } };
      return next;
    }
  }

  // Thinking grows the same way a reply does, and for the same reason: hundreds of chunks
  // would be hundreds of events for every later render to walk. The complete block arrives
  // after them saying the same thing, and replaces the run rather than following it.
  const reasoningId = reasoningIdOf(event);
  if (reasoningId && (event.type === 'assistant.reasoning_delta' || event.type === 'assistant.reasoning')) {
    const index = current.findIndex(
      (entry) =>
        (entry.type === 'assistant.reasoning_delta' || entry.type === 'assistant.reasoning') &&
        reasoningIdOf(entry) === reasoningId,
    );
    if (index !== -1) {
      const next = [...current];
      next[index] =
        event.type === 'assistant.reasoning'
          ? event
          : { ...event, data: { reasoningId, deltaContent: deltaOf(next[index]!) + deltaOf(event) } };
      return next;
    }
  }

  return [...current, event];
}

/**
 * The transcript as shown: history read from the log, then everything since.
 *
 * The two are held apart because they arrive on different schedules. Replaying history
 * is a request whose answer describes the log at the moment it was issued, so folding it
 * into one list lets a slow reply overwrite events that arrived while it was in flight -
 * including the user's own prompt, which then vanished until the session was reopened.
 */
export function timelineOf(history: TimelineEvent[], live: TimelineEvent[]): TimelineEvent[] {
  return live.length === 0 ? history : [...history, ...live];
}
