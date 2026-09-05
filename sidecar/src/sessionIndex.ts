import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionSummary } from '../../shared/protocol.js';
import { sessionStateDir, sessionStoreDb } from './paths.js';

/** How much of the last message to keep for the sidebar preview. */
const PREVIEW_LENGTH = 160;

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
    // The newest turn per session supplies the preview, preferring the assistant's reply.
    const rows = db
      .prepare(
        `SELECT s.id, s.cwd, s.repository, s.branch, s.summary, s.created_at, s.updated_at,
                COALESCE(t.assistant_response, t.user_message) AS preview
         FROM sessions s
         LEFT JOIN turns t
           ON t.session_id = s.id
          AND t.turn_index = (SELECT MAX(turn_index) FROM turns WHERE session_id = s.id)
         WHERE COALESCE(TRIM(s.summary), '') <> ''
            OR EXISTS (SELECT 1 FROM turns WHERE session_id = s.id)
         ORDER BY s.updated_at DESC`,
      )
      .all() as unknown as SessionRow[];

    return rows.map((row) => ({
      sessionId: row.id,
      title: readSessionName(row.id) ?? row.summary,
      cwd: row.cwd,
      repository: row.repository,
      branch: row.branch,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      preview: toPreview(row.preview),
      loaded: false,
    }));
  } finally {
    db.close();
  }
}

/** Collapse whitespace and clip, so the sidebar never renders a wall of text. */
function toPreview(raw: string | null): string | null {
  if (!raw) return null;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}
