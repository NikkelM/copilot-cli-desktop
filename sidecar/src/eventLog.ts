import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';

import type { GetTranscriptResult, TranscriptEvent } from '../../shared/protocol.js';
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
