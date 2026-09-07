import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionSummary } from '../../shared/protocol.js';
import { toPreview } from '../../shared/preview.js';
import { sessionEventLog, sessionStateDir, sessionStoreDb } from './paths.js';

/**
 * Names already read, keyed by session, with what the file looked like when they were.
 *
 * Reading `workspace.yaml` for every session was 49ms of a 113ms refresh - by far the most
 * expensive thing the list did, and almost entirely wasted: a session's name is set once and
 * then never changes. A stat is a tenth of the cost of an open-read-close, so the file is
 * only opened when it differs from what was read last.
 *
 * Bounded by the number of sessions on disk, and each entry is one short string.
 */
const names = new Map<string, { at: number; size: number; name: string | null }>();

/**
 * The session's display name, which lives outside the history database.
 *
 * `sessions.summary` holds an auto-generated summary derived from early conversation
 * and is not updated when a session is renamed, so a renamed session would otherwise
 * show stale text. `workspace.yaml` carries the authoritative name.
 *
 * Parsed by hand rather than with a YAML library: one scalar field is needed, the file
 * is written by the CLI in a flat predictable shape, and a dependency here would be
 * loaded for every session in the list.
 */
function readSessionName(sessionId: string): string | null {
  const path = join(sessionStateDir(sessionId), 'workspace.yaml');

  // One stat rather than an exists and a read: it answers whether the file is there and
  // whether it has changed since it was last read, which is everything needed to decide.
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) {
    names.delete(sessionId);
    return null;
  }

  const seen = names.get(sessionId);
  if (seen && seen.at === info.mtimeMs && seen.size === info.size) return seen.name;

  const name = parseSessionName(path);
  names.set(sessionId, { at: info.mtimeMs, size: info.size, name });
  return name;
}

/** The `name:` field, or null when the file has none or cannot be read. */
function parseSessionName(path: string): string | null {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^name:\s*(.*)$/.exec(line.trimEnd());
      if (!match) continue;

      // Values are quoted when they contain a colon, e.g. name: 'Reply with exactly: PONG'
      const raw = match[1]?.trim() ?? '';
      const unquoted = /^(['"])(.*)\1$/.exec(raw);
      const name = (unquoted ? unquoted[2] : raw) ?? '';
      return name.trim() || null;
    }
  } catch {
    return null; // A malformed or unreadable file just means falling back to the summary.
  }
  return null;
}

interface SessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  preview: string | null;
}

/**
 * Read the sidebar model straight out of the CLI's own history database.
 *
 * This is the core of the app's resource story: listing and previewing every session
 * costs one read-only SQLite query and spawns no Copilot process at all.
 *
 * Sessions with neither a title nor a single turn are excluded. They come from aborted
 * or crashed starts and hold nothing to return to; on a real store they were 95 of 167
 * entries. A session that was deliberately named is kept even with no turns, since
 * naming it was an intentional act.
 *
 * `keep` names sessions the runtime is holding open. One just started has no title and no
 * turns and is indistinguishable from a crashed start by the database alone, so without
 * this a new session disappears the moment it is made.
 */
export function listSessions(keep: readonly string[] = []): SessionSummary[] {
  if (!existsSync(sessionStoreDb)) return [];

  // readOnly still needs the -wal sidecar, so the CLI must not be mid-write; SQLite handles that.
  const db = new DatabaseSync(sessionStoreDb, { readOnly: true });
  try {
    const alsoHeld = keep.length > 0 ? `OR s.id IN (${keep.map(() => '?').join(',')})` : '';

    // The newest turn supplies both the preview and the last-used time: sessions.updated_at
    // is only written at creation or summary regeneration, so it can be hours stale while a
    // session is actively in use, which would also put it in the wrong place in the list.
    const rows = db
      .prepare(
        `SELECT s.id, s.cwd, s.repository, s.branch, s.summary, s.created_at,
                COALESCE(t.timestamp, s.updated_at) AS updated_at,
                COALESCE(t.assistant_response, t.user_message) AS preview
         FROM sessions s
         LEFT JOIN turns t
           ON t.session_id = s.id
          AND t.turn_index = (SELECT MAX(turn_index) FROM turns WHERE session_id = s.id)
         WHERE COALESCE(TRIM(s.summary), '') <> ''
            OR EXISTS (SELECT 1 FROM turns WHERE session_id = s.id)
            ${alsoHeld}
         ORDER BY COALESCE(t.timestamp, s.updated_at) DESC`,
      )
      .all(...keep) as unknown as SessionRow[];

    const held = new Set(keep);
    const sessions = rows
      .map((row) => ({ row, log: statSync(sessionEventLog(row.id), { throwIfNoEntry: false }) }))
      // The database and the logs are separate: deleting a session's directory, or
      // restoring a machine without it, leaves a row describing a session that cannot be
      // opened. Listing it promises something the transcript then cannot deliver.
      //
      // A session the runtime is holding is exempt: its log is written on the first turn,
      // so one just started has none yet and would otherwise be hidden as though deleted.
      .filter(({ row, log }) => held.has(row.id) || log !== undefined)
      .map(({ row, log }) => ({
        sessionId: row.id,
        title: readSessionName(row.id) ?? row.summary,
        cwd: row.cwd,
        repository: row.repository,
        branch: row.branch,
        createdAt: row.created_at,
        updatedAt: newest(log?.mtime.toISOString() ?? null, row.updated_at) ?? row.updated_at,
        preview: toPreview(row.preview),
        loaded: false,
      }));

    // The SQL ordering used the turn timestamp, which lastActivity may have superseded.
    return sessions.sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
  } finally {
    db.close();
  }
}

/** How many hidden sessions one lookup will return, so a short prefix cannot flood the list. */
const FIND_LIMIT = 20;

/**
 * Find sessions by the start of their id, including the ones the list leaves out.
 *
 * A session with no title and no turns is hidden from the sidebar deliberately - most are
 * crashed starts, and on this store they are 99 of 182. But a reader who has an id in hand,
 * from CLI output or a state directory, is asking about one specific session, and being
 * told it does not exist is wrong: it is on disk and can be opened.
 *
 * Kept apart from `listSessions` rather than folded into it because the cost is per row and
 * the list is the app's hottest path - measured, the hidden rows would take one refresh from
 * 28ms to around 60ms, for results nobody normally looks at. This pays only when asked.
 */
export function findSessions(prefix: string): SessionSummary[] {
  const needle = prefix.trim().toLowerCase();
  if (!needle || !existsSync(sessionStoreDb)) return [];

  const db = new DatabaseSync(sessionStoreDb, { readOnly: true });
  try {
    // LIKE with the wildcard only at the end is a prefix match, which is how an id is
    // quoted. ESCAPE keeps a literal _ or % in the query from acting as a pattern.
    const rows = db
      .prepare(
        `SELECT s.id, s.cwd, s.repository, s.branch, s.summary, s.created_at, s.updated_at
         FROM sessions s
         WHERE LOWER(s.id) LIKE ? ESCAPE '\\'
         ORDER BY s.updated_at DESC
         LIMIT ${FIND_LIMIT}`,
      )
      .all(`${needle.replace(/[\\%_]/g, '\\$&')}%`) as unknown as SessionRow[];

    return rows
      .map((row) => ({ row, log: statSync(sessionEventLog(row.id), { throwIfNoEntry: false }) }))
      .filter(({ log }) => log !== undefined)
      .map(({ row, log }) => ({
        sessionId: row.id,
        title: readSessionName(row.id) ?? row.summary,
        cwd: row.cwd,
        repository: row.repository,
        branch: row.branch,
        createdAt: row.created_at,
        updatedAt: newest(log?.mtime.toISOString() ?? null, row.updated_at) ?? row.updated_at,
        // A hidden session has no turn to preview, so there is nothing to read here.
        preview: null,
        loaded: false,
      }))
      .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
  } finally {
    db.close();
  }
}

/**
 * When the session last did anything, as an ISO timestamp.
 *
 * The `turns` table lags: rows are flushed well after the fact, and for a session held
 * open by this app the newest turn was measured eight minutes behind the log. The event
 * log is appended on every event, so its mtime is the truthful signal. Both are
 * considered, since a session with no log has only the database to go on.
 */
export function lastActivity(sessionId: string, fromTurns: string | null): string | null {
  const log = statSync(sessionEventLog(sessionId), { throwIfNoEntry: false });
  return newest(log?.mtime.toISOString() ?? null, fromTurns);
}

/**
 * Whichever of two times is later, allowing for either being absent.
 *
 * Split out from `lastActivity` because the listing already has the log's mtime in hand -
 * it stats the file to decide whether the session still exists - and statting it a second
 * time to answer the same question was a tenth of that loop's cost.
 */
function newest(logged: string | null, fromTurns: string | null): string | null {
  if (!logged) return fromTurns;
  if (!fromTurns) return logged;
  return toTime(logged) > toTime(fromTurns) ? logged : fromTurns;
}

/** SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC without a zone marker, so make it explicit. */
export function toTime(value: string): number {  const normalised = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalised).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The directory a session runs in, read on its own so a snapshot can be taken there. */
export function sessionCwd(sessionId: string): string | null {
  if (!existsSync(sessionStoreDb)) return null;

  const db = new DatabaseSync(sessionStoreDb, { readOnly: true });
  try {
    const row = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(sessionId) as { cwd?: string } | undefined;
    return row?.cwd ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
