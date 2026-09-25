import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { sessionStoreDb } from './paths.js';
import type { SessionMatch } from '../../shared/protocol.js';

/**
 * How many sessions a search may name.
 *
 * The sidebar draws what comes back, so this is a bound on the list rather than on the work:
 * FTS5 answers a broad query as fast as a narrow one, and a reader who has typed something
 * matching three hundred sessions has not narrowed anything yet.
 */
const MOST = 200;

/**
 * How many rows to read to find those sessions.
 *
 * One session can hold many matches, so rows and sessions are not the same count. FTS5 will
 * not group them - `snippet` cannot be used in that context - so the rows come back ranked
 * and are folded here, and this is the headroom that gives the fold something to fold.
 */
const ROWS = MOST * 8;

/**
 * Turn what was typed into something FTS5 will accept.
 *
 * Quoted as one phrase rather than split into terms, because that is what the filter box has
 * always meant: `hades biomes` finds those two words together, and treating them as two
 * conditions that may appear anywhere would quietly widen every query anyone already types.
 *
 * Quoting also makes the query safe. Inside a phrase FTS5 treats `:`, `-`, `*` and `\` as
 * ordinary characters, so a path or a stray operator searches for itself instead of being
 * read as syntax. The only character that still means something is the double quote, which
 * is escaped by doubling it.
 *
 * The trailing `*` matches the last word by prefix, so a query narrows as it is typed rather
 * than finding nothing until a word is finished.
 */
export function asPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"*`;
}

/**
 * Which sessions said something, and the words around where they said it.
 *
 * Read from the FTS5 index the CLI maintains, which costs one query and no Copilot process -
 * the same bargain the session list makes. Measured at 2-4ms over 206 sessions and 3.45 GB
 * of logs, so it runs on a keystroke rather than behind a button (#30).
 *
 * Only sessions the CLI has indexed can be found. That is 206 of 891 rows, but 675 of the
 * rest have no event log at all and are not in the sidebar either, so by content it is about
 * 97%. The seven real sessions it misses are a known gap rather than a reason to scan 3.45 GB.
 *
 * One row per session: the sidebar shows sessions, so the best-ranked snippet is the one
 * worth having and the rest of a session's matches would only push other sessions off the end.
 */
export function searchSessions(query: string): SessionMatch[] {
  const wanted = query.trim();
  if (!wanted || !existsSync(sessionStoreDb)) return [];

  const db = new DatabaseSync(sessionStoreDb, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT session_id, source_id,
                snippet(search_index, 0, char(2), char(3), '…', 14) AS excerpt
         FROM search_index
         WHERE search_index MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(asPhrase(wanted), ROWS) as unknown as {
      session_id: string;
      source_id: string;
      excerpt: string;
    }[];

    // Ranked order is kept, so the first row for a session is its best match and every later
    // one would only repeat the session further down the list.
    const found = new Map<string, SessionMatch>();
    for (const row of rows) {
      if (found.size >= MOST) break;
      if (found.has(row.session_id)) continue;
      found.set(row.session_id, {
        sessionId: row.session_id,
        excerpt: row.excerpt ?? '',
        turn: turnOf(row.source_id),
      });
    }

    return [...found.values()];
  } finally {
    db.close();
  }
}

/**
 * When a turn happened, and when the one after it did.
 *
 * A turn index is not a position in a log - there are more `user.message` events than there
 * are turns, 861 against 790 in one session here - so the log is reached through time rather
 * than through counting, which is the one thing the database and the log agree on.
 *
 * The next turn's time is what bounds this one. Reaching a fixed distance past a turn
 * instead overshoots into the turn after it on a busy log, which was measured landing a
 * whole question late.
 *
 * `next` is null for the last turn, which nothing follows.
 */
export function turnTime(sessionId: string, turn: number): { when: string; next: string | null } | null {
  if (!existsSync(sessionStoreDb)) return null;

  const db = new DatabaseSync(sessionStoreDb, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT turn_index, timestamp FROM turns
         WHERE session_id = ? AND turn_index IN (?, ?) ORDER BY turn_index`,
      )
      .all(sessionId, turn, turn + 1) as unknown as { turn_index: number; timestamp?: string }[];

    const found = rows.find((row) => row.turn_index === turn);
    if (!found?.timestamp) return null;

    const after = rows.find((row) => row.turn_index === turn + 1);
    return { when: String(found.timestamp), next: after?.timestamp ? String(after.timestamp) : null };
  } finally {
    db.close();
  }
}

/**
 * Which turn a match sits in, when it sits in one.
 *
 * `source_id` is a composite string rather than a key into `turns`, so the index is read out
 * of it: `<sessionId>:turn:269` is turn 269, while `<sessionId>:ckpt:0:checkpoint_history`
 * is part of a checkpoint and has no turn to go to.
 */
export function turnOf(sourceId: string): number | null {
  const parts = String(sourceId ?? '').split(':');
  const at = parts.indexOf('turn');
  if (at < 0) return null;

  // Tested for digits rather than handed to Number, which reads the empty string as zero -
  // and a malformed id quietly becoming turn zero would send the reader to the wrong place.
  const index = parts[at + 1];
  if (!index || !/^\d+$/.test(index)) return null;

  return Number(index);
}
