import { existsSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

import type { GetTranscriptResult, SessionModel, TranscriptEvent } from '../../shared/protocol.js';
import { sessionEventLog } from './paths.js';

/** Default cap on events per read; logs reach hundreds of thousands of entries. */
const DEFAULT_LIMIT = 500;

/** First slice read from the end of the range. Comfortably covers a typical 500 events. */
const INITIAL_WINDOW = 256 * 1024;

/** How much the window grows when the tail did not hold enough events. */
const GROWTH_FACTOR = 4;

/**
 * Stop growing rather than read an entire multi-hundred-megabyte log.
 * Returning slightly fewer events is a far better outcome than a long freeze.
 */
const MAX_WINDOW = 32 * 1024 * 1024;

interface LocatedEvent {
  event: TranscriptEvent;
  /** Byte offset where this event's line begins. */
  offset: number;
}

/**
 * Replay part of a session's transcript without loading it into the CLI runtime.
 *
 * Read backwards from the end of the range rather than streaming from the start. Logs
 * reach 287 MB locally and total about 1.8 GB, so scanning forward to keep the newest 500
 * events cost roughly three seconds per open, which contradicts the whole point of
 * browsing being cheap.
 *
 * events.jsonl uses the same shape as the SDK's live event stream, so the renderer treats
 * replayed and live events identically.
 *
 * @param before byte offset to treat as the end of the file, for paging further back
 */
export async function readTranscript(
  sessionId: string,
  limit = DEFAULT_LIMIT,
  before?: number,
): Promise<GetTranscriptResult> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return { events: [], truncated: false, nextBefore: null };

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const end = before === undefined ? size : Math.max(0, Math.min(before, size));
    if (end === 0) return { events: [], truncated: false, nextBefore: null };

    let window = Math.min(INITIAL_WINDOW, end);

    for (;;) {
      const start = Math.max(0, end - window);
      const reachedStart = start === 0;

      const buffer = Buffer.alloc(end - start);
      await file.read(buffer, 0, buffer.length, start);

      const located = locateEvents(buffer, start, reachedStart);

      if (located.length >= limit || reachedStart || window >= MAX_WINDOW) {
        const kept = located.slice(-limit);
        const more = !reachedStart || kept.length < located.length;

        return {
          events: kept.map((entry) => entry.event),
          truncated: more,
          // Where the next page should stop reading. Points at the first event actually
          // returned, not the window start, since the window's first line is normally
          // partial and further events may be dropped when slicing to the limit.
          nextBefore: more ? (kept[0]?.offset ?? null) : null,
        };
      }

      window = Math.min(window * GROWTH_FACTOR, end, MAX_WINDOW);
    }
  } finally {
    await file.close();
  }
}

/**
 * The model a session was last using, read from its log.
 *
 * Read from both ends, because neither alone is enough. A change is recorded wherever it
 * happened, so the tail is where a recent one will be; but a session that has simply been
 * running on the same model for a long time has no change anywhere near the end. One log
 * here is 300 MB with nothing to say about its model in the last 32 MB, while the first
 * line of every log names the model the run opened with.
 *
 * Both reads are bounded, so this costs a few hundred kilobytes rather than a process: a
 * session can say what it runs on without being started to ask.
 */
export async function lastModel(sessionId: string): Promise<SessionModel | null> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return null;

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return null;

    let window = Math.min(INITIAL_WINDOW, size);

    for (;;) {
      const start = Math.max(0, size - window);
      const reachedStart = start === 0;

      const named = latestModelIn(await eventsIn(file, start, size, reachedStart));
      if (named) return named;

      if (reachedStart || window >= MAX_WINDOW) break;
      window = Math.min(window * GROWTH_FACTOR, size, MAX_WINDOW);
    }

    // Nothing recent to go on, so fall back to what the run opened with. session.start is
    // the first line of the file, which is why this reads a window rather than the lot.
    return latestModelIn(await eventsIn(file, 0, Math.min(INITIAL_WINDOW, size), true));
  } finally {
    await file.close();
  }
}

/**
 * The last event in a slice that actually names a model.
 *
 * Searched from the end because later is more recent, and skipping rather than stopping at
 * one that names nothing: an older CLI wrote `session.start` without the model on it, and
 * stopping there would miss the change on the very next line.
 */
function latestModelIn(events: TranscriptEvent[]): SessionModel | null {
  for (let index = events.length - 1; index >= 0; index--) {
    if (!NAMES_A_MODEL.has(events[index].type)) continue;

    const named = modelOf(events[index]);
    if (named) return named;
  }
  return null;
}

/** The events in one slice of the log, skipping the partial line a mid-file start leaves. */
async function eventsIn(
  file: FileHandle,
  start: number,
  end: number,
  reachedStart: boolean,
): Promise<TranscriptEvent[]> {
  const buffer = Buffer.alloc(end - start);
  await file.read(buffer, 0, buffer.length, start);

  return locateEvents(buffer, start, reachedStart).map((entry) => entry.event);
}

/**
 * The events that say what a session runs on.
 *
 * A change reports the model it moved to; the start or resume of a run reports the one it
 * opened with, under a different name. Four of the twenty-eight logs here have no change in
 * them at all, so the second is not a fallback worth skipping.
 */
const NAMES_A_MODEL = new Set(['session.model_change', 'session.start', 'session.resume']);

function modelOf(event: TranscriptEvent): SessionModel | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const model = data.newModel ?? data.selectedModel;
  if (typeof model !== 'string') return null;

  return {
    model,
    reasoningEffort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort : undefined,
    contextTier: typeof data.contextTier === 'string' ? data.contextTier : undefined,
  };
}

/**
 * Parse the lines in a window, recording where each event began.
 *
 * Unless the window reaches the start of the file its first line began before it and is
 * incomplete, so it is skipped. That also discards any partial multi-byte character
 * introduced by starting mid-file.
 */
function locateEvents(buffer: Buffer, start: number, reachedStart: boolean): LocatedEvent[] {
  const events: LocatedEvent[] = [];
  const lines = buffer.toString('utf8').split('\n');
  let offset = start;

  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1; // the newline that split() removed

    if (index === 0 && !reachedStart) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      events.push({ event: JSON.parse(trimmed) as TranscriptEvent, offset: lineStart });
    } catch {
      // A partially flushed trailing line is expected while a session is live.
    }
  }

  return events;
}
