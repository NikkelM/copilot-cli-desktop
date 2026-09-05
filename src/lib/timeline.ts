import type { TranscriptEvent } from '../../shared/protocol';

/** A transcript event, or one the app invented before the runtime confirmed it. */
export type TimelineEvent = TranscriptEvent & { local?: boolean };

export function contentOf(event: TranscriptEvent): string | null {
  const data = event.data as { content?: unknown } | null;
  return typeof data?.content === 'string' ? data.content : null;
}

/**
 * Add an event arriving from a live session to the events seen since it was selected.
 *
 * A prompt is shown optimistically so it appears the moment it is sent, and the runtime
 * echoes the same message back a beat later. The echo replaces the optimistic entry
 * rather than following it, which would show the prompt twice.
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
