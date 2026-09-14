/**
 * Which sessions exist, read straight from the session directory.
 *
 * Deliberately overlaps the SDK's `sessions.list` and `sessions.getMetadata` (#143). Every
 * SDK equivalent needs the server running and the session loaded, which is precisely what
 * this app exists not to do: the sidebar lists two hundred sessions and shows each one's
 * last message with zero Copilot processes. That is the whole bargain, so this stays.
 */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, type Stats } from 'node:fs';
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

/**
 * Previews already read, keyed by session, with what the log looked like when they were.
 *
 * The same bargain `names` makes, and an even better one here: the stat that decides whether
 * the log has moved is one `listSessions` already performs, so an idle session costs nothing
 * beyond what the list was doing anyway.
 */
const previews = new Map<string, { at: number; size: number; preview: string | null }>();

/** First slice read from the end of a log. Held the newest message in 166 of 187 sessions here. */
const PREVIEW_WINDOW = 16 * 1024;

/** How much the window grows when the tail held no message. */
const PREVIEW_GROWTH = 4;

/** Stop rather than read a multi-hundred-megabyte log to the start for one line of sidebar text. */
const PREVIEW_MAX_WINDOW = 4 * 1024 * 1024;

/**
 * The newest thing said in a session, read from the end of its log.
 *
 * The history database is the obvious source and the wrong one. `turns` is written lazily and
 * is not flushed on shutdown, so a quarter of the sessions here previewed text that was hours
 * or days out of date while the timestamp printed beside it, which does consult the log, was
 * right (#164). One session's newest turn row was from the previous day, and had no assistant
 * response on it, so the sidebar showed a question from the start of a session whose transcript
 * ended somewhere else entirely.
 *
 * Kept here rather than taken from `eventLog`, whose business is paging a transcript
 * asynchronously for the viewer. This wants one event, synchronously, from a window small
 * enough that the list can afford it for every session at once.
 */
function readPreview(sessionId: string, log: Stats): string | null {
  const seen = previews.get(sessionId);
  if (seen && seen.at === log.mtimeMs && seen.size === log.size) return seen.preview;

  const preview = lastMessageIn(sessionEventLog(sessionId), log.size);
  previews.set(sessionId, { at: log.mtimeMs, size: log.size, preview });
  return preview;
}

/**
 * Read backwards in a window that grows, because the newest message is usually within a few
 * kilobytes of the end but a closing run of large tool results can push it a long way back.
 */
function lastMessageIn(path: string, size: number): string | null {
  if (size === 0) return null;

  let handle: number | undefined;
  try {
    handle = openSync(path, 'r');
    let window = Math.min(PREVIEW_WINDOW, size);

    for (;;) {
      const start = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - start);
      readSync(handle, buffer, 0, buffer.length, start);

      const lines = buffer.toString('utf8').split('\n');
      // A window that starts mid-file almost never starts on a line boundary.
      if (start > 0) lines.shift();

      const found = newestMessageIn(lines);
      if (found) return found;

      if (start === 0 || window >= PREVIEW_MAX_WINDOW) return null;
      window = Math.min(window * PREVIEW_GROWTH, size, PREVIEW_MAX_WINDOW);
    }
  } catch {
    return null; // An unreadable log just means falling back to what the database recorded.
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * What was last said among these lines, newest first.
 *
 * The string test before parsing is what makes the window affordable: a log's bulk is tool
 * results, some of them megabytes of file content, and none of them worth handing to a JSON
 * parser to discover they are not a message.
 */
function newestMessageIn(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line) continue;
    if (!line.includes('"user.message"') && !line.includes('"assistant.message"')) continue;

    let event: { type?: string; data?: { content?: unknown } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== 'user.message' && event.type !== 'assistant.message') continue;

    const content = event.data?.content;
    if (typeof content === 'string' && content.trim()) return content;
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

    // The newest turn supplies the last-used time: sessions.updated_at is only written at
    // creation or summary regeneration, so it can be hours stale while a session is actively
    // in use, which would also put it in the wrong place in the list. Its text is only a
    // fallback for the log, which is the one that keeps up (#164).
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
      // An empty log counts as none. That is what a start which wrote nothing leaves, and
      // resuming it fails with "Cannot create session from empty events array" - a row that
      // can only ever produce an error is not worth offering.
      //
      // A session the runtime is holding is exempt, but only while its state directory is
      // still there: its log is written on the first turn, so one just started has none yet
      // and would otherwise be hidden as though deleted. A held session whose directory has
      // gone is not that case, and used to sit in the list failing forever (#141).
      .filter(
        ({ row, log }) =>
          (log !== undefined && log.size > 0) || (held.has(row.id) && existsSync(sessionStateDir(row.id))),
      )
      .map(({ row, log }) => ({
        sessionId: row.id,
        title: readSessionName(row.id) ?? row.summary,
        cwd: row.cwd,
        repository: row.repository,
        branch: row.branch,
        createdAt: row.created_at,
        updatedAt: newest(log?.mtime.toISOString() ?? null, row.updated_at) ?? row.updated_at,
        preview: toPreview((log ? readPreview(row.id, log) : null) ?? row.preview),
        loaded: false,
      }));

    // The SQL ordering used the turn timestamp, which lastActivity may have superseded.
    return sessions.sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
  } finally {
    db.close();
  }
}

/**
 * Which of these sessions still exist on disk.
 *
 * The state directory is what defines a session, so its absence is the one unambiguous
 * answer to "is this gone". The list is not: a session can be missing from it for reasons
 * that have nothing to do with deletion, and treating that as gone would throw away what
 * the app remembers about a session that is still there (#152).
 */
export function existingSessions(ids: readonly string[]): string[] {
  return ids.filter((id) => existsSync(sessionStateDir(id)));
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
      // Same rule as the list: a session with no log, or an empty one, cannot be opened, so
      // handing one back to someone who quoted its id would only fail later.
      .filter(({ log }) => log !== undefined && log.size > 0)
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
