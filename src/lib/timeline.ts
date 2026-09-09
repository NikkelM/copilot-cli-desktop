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

function toolCallIdOf(event: TranscriptEvent): string | null {
  const data = event.data as { toolCallId?: unknown } | null;
  return typeof data?.toolCallId === 'string' ? data.toolCallId : null;
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

  /**
   * A running tool's output, which arrives repeatedly while it runs.
   *
   * Replaced rather than folded, because `partialOutput` is the whole output so far and
   * not the increment its name and the SDK's own documentation promise. Appending would
   * repeat every line as many times as it was sent. Verified against the runtime: a
   * twelve-second command sent thirteen of these, each one carrying all of it.
   *
   * Replacing also keeps a chatty command from costing quadratic memory, since otherwise
   * every chunk would leave behind a copy of everything before it.
   */
  if (event.type === 'tool.execution_partial_result') {
    const toolCallId = toolCallIdOf(event);
    const index = toolCallId
      ? current.findIndex(
          (entry) => entry.type === 'tool.execution_partial_result' && toolCallIdOf(entry) === toolCallId,
        )
      : -1;
    if (index !== -1) {
      const next = [...current];
      next[index] = event;
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
 *
 * Which leaves the other side of that seam: an event delivered while the replay was in
 * flight can also have been written to the log in time to come back in the same answer.
 * Both copies describe one thing that happened once, so the live one is dropped. Events
 * the app invented itself carry ids nothing else can produce, so they always survive.
 */
export function timelineOf(history: TimelineEvent[], live: TimelineEvent[]): TimelineEvent[] {
  if (live.length === 0) return history;
  if (history.length === 0) return live;

  const known = new Set(history.map((event) => event.id));
  return [...history, ...live.filter((event) => !event.id || !known.has(event.id))];
}
