import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';

import type { GetTranscriptResult, TranscriptEvent } from '../../shared/protocol.js';
import { sessionEventLog } from './paths.js';

/** Default cap on replayed events; logs reach hundreds of entries and several MB. */
const DEFAULT_LIMIT = 500;

/**
 * Replay a session's transcript from disk without loading it into the CLI runtime.
 *
 * events.jsonl uses the same shape as the SDK's live SessionEvent stream, so the
 * renderer treats replayed and live events identically.
 */
export async function readTranscript(sessionId: string, limit = DEFAULT_LIMIT): Promise<GetTranscriptResult> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return { events: [], truncated: false };

  const file = await open(path, 'r');
  try {
    // Ring buffer keeps only the newest `limit` events, so memory stays bounded
    // regardless of log size.
    const window: TranscriptEvent[] = [];
    let seen = 0;

    for await (const line of file.readLines({ encoding: 'utf8' })) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: TranscriptEvent;
      try {
        parsed = JSON.parse(trimmed) as TranscriptEvent;
      } catch {
        continue; // A partially flushed trailing line is expected while a session is live.
      }

      seen += 1;
      window.push(parsed);
      if (window.length > limit) window.shift();
    }

    return { events: window, truncated: seen > window.length };
  } finally {
    await file.close();
  }
}
