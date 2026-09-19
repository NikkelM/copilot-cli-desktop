/**
 * Which sessions exist, read straight from the session directory.
 *
 * Deliberately overlaps the SDK's `sessions.list` and `sessions.getMetadata` (#143). Every
 * SDK equivalent needs the server running and the session loaded, which is precisely what
 * this app exists not to do: the sidebar lists two hundred sessions and shows each one's
 * last message with zero Copilot processes. That is the whole bargain, so this stays.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';

import type { SessionSummary } from '../../shared/protocol.js';
import { sessionEventLog, sessionStateDir, sessionStoreDb } from './paths.js';

/**
 * Workspaces already read, keyed by session, with what the file looked like when they were.
 *
 * Reading `workspace.yaml` for every session was 49ms of a 113ms refresh - by far the most
 * expensive thing the list did, and almost entirely wasted: what it says about a session is
 * set once and then rarely changes. A stat is a tenth of the cost of an open-read-close, so
 * the file is only opened when it differs from what was read last.
 *
 * Bounded by the number of sessions on disk, and each entry is a handful of short strings.
 */
const workspaces = new Map<string, { at: number; size: number; workspace: Workspace | null }>();

/** What `workspace.yaml` says about a session. A field the file omits is null. */
interface Workspace {
  name: string | null;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
}

/**
 * What the session itself says about its workspace, which the history database does not.
 *
 * The database is written once and not corrected. `sessions.summary` holds an auto-generated
 * summary and does not follow a rename, and `sessions.repository` can name a repository the
 * session has nothing to do with: across a real store, 29 rows named one where the session's
 * own workspace has none, 28 of them for a session whose directory is not a repository at
 * all. `workspace.yaml` is written by the CLI as the workspace changes and is the answer.
 *
 * Read for every session in the list, so it is cached against the file's own mtime and size
 * and parsed by hand: the fields are few, the CLI writes a flat predictable shape, and a
 * YAML dependency here would be loaded once per session.
 */
function readWorkspace(sessionId: string): Workspace | null {
  const path = join(sessionStateDir(sessionId), 'workspace.yaml');

  // One stat rather than an exists and a read: it answers whether the file is there and
  // whether it has changed since it was last read, which is everything needed to decide.
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) {
    workspaces.delete(sessionId);
    return null;
  }

  const seen = workspaces.get(sessionId);
  if (seen && seen.at === info.mtimeMs && seen.size === info.size) return seen.workspace;

  const workspace = parseWorkspace(path);
  workspaces.set(sessionId, { at: info.mtimeMs, size: info.size, workspace });
  return workspace;
}

/** Longest a session name may be, which is what the CLI's own box accepts. */
const MAX_NAME = 200;

/**
 * Give a session a name of somebody's choosing.
 *
 * Written into `workspace.yaml` because there is nowhere else to write it. The CLI renames
 * through an in-process native binding rather than over the wire, so no client can ask it to:
 * the SDK has no rename, and the RPC surface has none either. Writing the file is the only
 * way to give a session a name that the CLI will also show.
 *
 * Safe to write, which was tested rather than assumed: a name written here survived the CLI
 * taking another turn on the same session, with the CLI rewriting the rest of the file around
 * it. Written atomically all the same, through a temporary file and a rename, so a crash
 * partway through cannot leave a session with no workspace at all.
 *
 * `user_named` goes with it. Without it the CLI counts the name as one it generated and will
 * generate another later - ten of the fourteen named sessions on this machine were auto-named
 * first, so the two fields genuinely travel together.
 */
export function renameSession(sessionId: string, name: string): void {
  const wanted = name.trim();
  if (!wanted) throw new Error('A session needs a name.');
  if (wanted.length > MAX_NAME) throw new Error(`A name can be at most ${MAX_NAME} characters.`);
  // A newline would not be a long name, it would be a different file.
  if (/[\r\n]/.test(wanted)) throw new Error('A name cannot span lines.');

  const path = join(sessionStateDir(sessionId), 'workspace.yaml');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // Sessions old enough to predate the file cannot be renamed, and inventing one would
    // describe a workspace this app knows nothing about.
    throw new Error('This session has no workspace to name.');
  }

  const written = setField(setField(text, 'name', quoted(wanted)), 'user_named', 'true');
  const temporary = `${path}.writing`;
  writeFileSync(temporary, written);
  renameSync(temporary, path);
}

/**
 * A YAML scalar, quoted only when it would otherwise be read as something else.
 *
 * Single quotes, doubling any of its own, which is YAML's own escape and the form the CLI
 * writes: `name: 'Reply with exactly: PONG'`.
 */
function quoted(value: string): string {
  if (!/[:#'"]|^\s|\s$|^[-?&*!|>%@`]/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** Replace a field's line, or add it when the file has none. */
function setField(text: string, field: string, value: string): string {
  const line = `${field}: ${value}`;
  const pattern = new RegExp(`^${field}:.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, line);

  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

/** The fields the sidebar needs, or null when the file cannot be read at all. */
function parseWorkspace(path: string): Workspace | null {
  const found: Workspace = { name: null, cwd: null, repository: null, branch: null };

  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^(name|cwd|repository|branch):\s*(.*)$/.exec(line.trimEnd());
      if (!match) continue;

      // Values are quoted when they contain a colon, e.g. name: 'Reply with exactly: PONG'
      // A quoted value may carry the quote it is wrapped in, doubled, which is YAML's own
      // escape - so undoing the quoting means undoing that too, or a name reads back with
      // more apostrophes than it was given.
      const raw = match[2]?.trim() ?? '';
      const unquoted = /^(['"])([\s\S]*)\1$/.exec(raw);
      const quote = unquoted?.[1] ?? '';
      const inner = quote ? (unquoted?.[2] ?? '').split(quote + quote).join(quote) : raw;
      found[match[1] as keyof Workspace] = inner.trim() || null;
    }
  } catch {
    return null; // A malformed or unreadable file just means falling back to the database.
  }

  return found;
}


interface SessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One row and its log, as the sidebar wants it.
 *
 * The session's own `workspace.yaml` wins wherever it exists, including where it says a
 * session has no repository: that is an answer rather than a gap. The database's columns are
 * written once and not corrected, so a session that was first associated with a repository
 * keeps naming it long after it has nothing to do with it. Only a session with no workspace
 * file at all falls back to them, which is what a session predating the file looks like.
 */
function summarise(row: SessionRow, log: Stats | undefined): SessionSummary {
  const workspace = readWorkspace(row.id);

  return {
    sessionId: row.id,
    title: workspace?.name ?? row.summary,
    cwd: workspace ? workspace.cwd : row.cwd,
    repository: workspace ? workspace.repository : row.repository,
    branch: workspace ? workspace.branch : row.branch,
    createdAt: row.created_at,
    updatedAt: newest(log?.mtime.toISOString() ?? null, row.updated_at) ?? row.updated_at,
    loaded: false,
  };
}

/**
 * Read the sidebar model straight out of the CLI's own history database.
 *
 * This is the core of the app's resource story: listing every session
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
                COALESCE(t.timestamp, s.updated_at) AS updated_at
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
      .map(({ row, log }) => summarise(row, log));

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
      .map(({ row, log }) => summarise(row, log))
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
