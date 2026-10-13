import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { sessionEventLog } from './paths.js';
import { toPreview } from '../../shared/preview.js';

/**
 * What a session last said, for the rows the reader can actually see (#240).
 *
 * This was removed once, and the reasons it was removed are the design here. It used to run
 * for every session whose log had moved, on every refresh of a list of two hundred, with a
 * window that grew to 4 MB when the tail held no message. So now it is asked only about the
 * rows on screen, reads a fixed window, and remembers what it found.
 *
 * The history database would be free to read and is not usable: of 935 sessions there, 218
 * have any turn recorded at all, a fifth of those are stale by an hour to eighty days, and
 * the two most recently active both held an empty string. The log is the only place the
 * answer is right.
 */

/**
 * How much of a log's tail to read.
 *
 * Measured over the sixty most recently written logs here: 16 KB found a message in half of
 * them and 64 KB in four fifths, for 40 ms and 3.5 MB across all sixty. Past that the curve
 * flattens - what is left is a session whose tail is one enormous tool result - and growing
 * the window for those is what made the old reader expensive.
 */
const WINDOW = 64 * 1024;

/**
 * How much of a reply to hand over.
 *
 * Enough to fill the most lines a row will ever draw, at a sidebar dragged wide. Five lines
 * of about a hundred characters is five hundred, and the clipping that matters is the one
 * the browser does, which knows the width this does not. Twenty rows of this is ten
 * kilobytes, which is nothing beside the 64 KB each one was read from.
 */
const ROOM = 500;

/** What a log looked like when it was last read, so an unchanged one is never read twice. */
interface Seen {
  size: number;
  mtimeMs: number;
  preview: string | null;
}

const seen = new Map<string, Seen>();

/**
 * The newest assistant message in the tail of a log, given a handle already opened.
 *
 * Backwards from the end, because the answer is almost always the last few lines and the
 * first line in the window is usually half a line. A line that will not parse is skipped
 * rather than abandoning the search: that is what the window's own edge looks like.
 */
function lastSaid(fd: number, size: number): string | null {
  const take = Math.min(size, WINDOW);
  const buffer = Buffer.allocUnsafe(take);
  readSync(fd, buffer, 0, take, size - take);

  const lines = buffer.toString('utf8').split('\n');
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]!;
    // Cheaper than parsing every line to find out it was a tool call.
    if (!line.includes('"assistant.message"')) continue;
    try {
      const content = (JSON.parse(line) as { data?: { content?: unknown } })?.data?.content;
      if (typeof content === 'string') {
        const preview = toPreview(content, ROOM);
        if (preview) return preview;
      }
    } catch {
      // Half a line at the window's edge, which is expected rather than exceptional.
    }
  }

  return null;
}

/**
 * What each of these sessions last said, skipping any whose log has not moved.
 *
 * The log is measured before it is read, which is the whole of the saving: a session that
 * has not moved since the last look costs one `fstat` rather than 64 KB. On a list where
 * most rows are idle that is the difference between this being worth having and not.
 *
 * Returns only the ones that have something to show, so a caller holding the answer can
 * tell "nothing yet" from "nothing to say" without a second field.
 */
export function sessionPreviews(sessionIds: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};

  for (const sessionId of sessionIds) {
    let fd: number;
    try {
      fd = openSync(sessionEventLog(sessionId), 'r');
    } catch {
      // No log is a session that has never run, or one that has been deleted. Either way
      // there is nothing to remember about it, and a session that has gone would otherwise
      // be held here by the memory of when it had not.
      seen.delete(sessionId);
      continue;
    }

    try {
      const { size, mtimeMs } = fstatSync(fd);
      const before = seen.get(sessionId);
      const unchanged = before && before.size === size && before.mtimeMs === mtimeMs;

      const preview = unchanged ? before.preview : lastSaid(fd, size);
      if (!unchanged) seen.set(sessionId, { size, mtimeMs, preview });
      if (preview) out[sessionId] = preview;
    } catch {
      // Gone or unreadable between opening and reading, which says nothing worth saying.
    } finally {
      closeSync(fd);
    }
  }

  return out;
}

/** Forget what was read, for tests and for a session that has gone. */
export function forgetPreviews(): void {
  seen.clear();
}
