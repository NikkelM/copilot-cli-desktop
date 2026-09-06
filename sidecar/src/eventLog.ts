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
    let found: SessionModel | null = null;

    for (;;) {
      const start = Math.max(0, size - window);
      const reachedStart = start === 0;

      found = latestModelIn(await eventsIn(file, start, size, reachedStart));
      if (found) break;

      if (reachedStart || window >= MAX_WINDOW) break;
      window = Math.min(window * GROWTH_FACTOR, size, MAX_WINDOW);
    }

    // The opening of the run is worth reading in two cases: when the tail said nothing at
    // all, and when it named a model without saying how it was set up. Neither is unusual -
    // a change event often carries the model and the effort but not the context.
    if (!found || !found.reasoningEffort || !found.contextTier) {
      const opening = latestModelIn(await eventsIn(file, 0, Math.min(INITIAL_WINDOW, size), true));

      if (!found) found = opening;
      else if (opening) {
        found.reasoningEffort ??= opening.reasoningEffort;
        found.contextTier ??= opening.contextTier;
      }
    }

    return found;
  } finally {
    await file.close();
  }
}

/**
 * What a slice of the log says a session runs on, the newest mention of each part winning.
 *
 * Assembled part by part rather than taken from one event, because no single event reliably
 * carries all three: a change often names the model and the effort but not the context, and
 * the line a run opens with sometimes carries the context and no model at all. Reading only
 * the newest event that names a model loses whatever that event left out, which is what put
 * an effort and a context the session really had out of the header.
 */
function latestModelIn(events: TranscriptEvent[]): SessionModel | null {
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let contextTier: string | undefined;

  for (let index = events.length - 1; index >= 0; index--) {
    if (!NAMES_A_MODEL.has(events[index].type)) continue;
    const data = (events[index].data ?? {}) as Record<string, unknown>;

    model ??= textOf(data.newModel) ?? textOf(data.selectedModel);
    reasoningEffort ??= textOf(data.reasoningEffort);
    contextTier ??= textOf(data.contextTier);

    if (model && reasoningEffort && contextTier) break;
  }

  return model ? { model, reasoningEffort, contextTier } : null;
}

/** Null is what the runtime writes for a setting nobody chose, which is not a value. */
const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

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
