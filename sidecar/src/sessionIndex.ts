import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

import type { SessionSummary } from '../../shared/protocol.js';
import { sessionStoreDb } from './paths.js';

/** How much of the last message to keep for the sidebar preview. */
const PREVIEW_LENGTH = 160;

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
         ORDER BY s.updated_at DESC`,
      )
      .all() as unknown as SessionRow[];

    return rows.map((row) => ({
      sessionId: row.id,
      title: row.summary,
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
