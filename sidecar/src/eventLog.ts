import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';

import type { GetTranscriptResult, TranscriptEvent } from '../../shared/protocol.js';
import { sessionEventLog } from './paths.js';

/** Default cap on replayed events; logs reach hundreds of thousands of entries. */
const DEFAULT_LIMIT = 500;

/** First slice read from the end of the log. Comfortably covers a typical 500 events. */
const INITIAL_WINDOW = 256 * 1024;

/** How much the window grows when the tail did not hold enough events. */
const GROWTH_FACTOR = 4;

/**
 * Stop growing rather than read an entire multi-hundred-megabyte log.
 * Returning slightly fewer events is a far better outcome than a long freeze.
 */
const MAX_WINDOW = 32 * 1024 * 1024;

/**
 * Replay the tail of a session's transcript without loading it into the CLI runtime.
 *
 * Read backwards from the end rather than streaming from the start. Logs reach 287 MB
 * locally and total about 1.8 GB, so scanning forward to keep the newest 500 events cost
 * roughly three seconds per open, which contradicts the whole point of browsing being
 * cheap.
 *
 * events.jsonl uses the same shape as the SDK's live event stream, so the renderer treats
 * replayed and live events identically.
 */
export async function readTranscript(
  sessionId: string,
  limit = DEFAULT_LIMIT,
): Promise<GetTranscriptResult> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return { events: [], truncated: false };

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return { events: [], truncated: false };

    let window = Math.min(INITIAL_WINDOW, size);

    for (;;) {
      const start = Math.max(0, size - window);
      const reachedStart = start === 0;

      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);

      const lines = buffer.toString('utf8').split('\n');

      // Unless the whole file is in view, the first line began before the window and is
      // incomplete. Dropping it also discards any partial multi-byte character.
      if (!reachedStart) lines.shift();

      const events = parseEvents(lines);

      if (events.length >= limit || reachedStart || window >= MAX_WINDOW) {
        const kept = events.slice(-limit);
        return { events: kept, truncated: !reachedStart || kept.length < events.length };
      }

      window = Math.min(window * GROWTH_FACTOR, size, MAX_WINDOW);
    }
  } finally {
    await file.close();
  }
}

function parseEvents(lines: string[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TranscriptEvent);
    } catch {
      // A partially flushed trailing line is expected while a session is live.
    }
  }

  return events;
}
