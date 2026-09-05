import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionSummary } from '../../shared/protocol.js';
import { toPreview } from '../../shared/preview.js';
import { sessionEventLog, sessionStateDir, sessionStoreDb } from './paths.js';

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
  if (!existsSync(path)) return null;

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
    return null; // A missing or malformed file just means falling back to the summary.
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
 */
export function listSessions(): SessionSummary[] {
  if (!existsSync(sessionStoreDb)) return [];

  // readOnly still needs the -wal sidecar, so the CLI must not be mid-write; SQLite handles that.
  const db = new DatabaseSync(sessionStoreDb, { readOnly: true });
  try {
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
         ORDER BY COALESCE(t.timestamp, s.updated_at) DESC`,
      )
      .all() as unknown as SessionRow[];

    const sessions = rows.map((row) => ({
      sessionId: row.id,
      title: readSessionName(row.id) ?? row.summary,
      cwd: row.cwd,
      repository: row.repository,
      branch: row.branch,
      createdAt: row.created_at,
      updatedAt: lastActivity(row.id, row.updated_at) ?? row.updated_at,
      preview: toPreview(row.preview),
      loaded: false,
    }));

    // The SQL ordering used the turn timestamp, which lastActivity may have superseded.
    return sessions.sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
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
  let logged: string | null = null;
  try {
    logged = statSync(sessionEventLog(sessionId)).mtime.toISOString();
  } catch {
    logged = null; // No log yet, or unreadable.
  }

  if (!logged) return fromTurns;
  if (!fromTurns) return logged;
  return toTime(logged) > toTime(fromTurns) ? logged : fromTurns;
}

/** SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC without a zone marker, so make it explicit. */
export function toTime(value: string): number {
  const normalised = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalised).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
