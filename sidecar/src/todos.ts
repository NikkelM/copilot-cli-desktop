import { DatabaseSync } from 'node:sqlite';

import type { Todo } from '../../shared/protocol.js';
import { sessionDatabase } from './paths.js';

/**
 * The agent's own todo list, read from the session's database (#172).
 *
 * Read from the file rather than asked of the runtime, which is the whole difference
 * between a list that appears and one that does not. The SDK offers
 * `plan.readSqlTodosWithDependencies`, but that needs the session loaded, and this app
 * loads nothing until somebody asks it to - so a list read that way is empty for every
 * session in the sidebar until the moment it is worked in. The rows are on disk either
 * way. Reading them there is the same bet the transcript already makes, and it is the one
 * this app is built on.
 *
 * Opened read-only, so nothing here can damage a database a live session is writing to.
 *
 * Every failure is an empty list. No database, no table, a schema that has moved, a lock
 * held by the session mid-write: none of them is worth a word to the reader, because the
 * list is the agent's account of its own work rather than a record of anything, and the
 * whole consequence of getting it wrong is a panel that does not open.
 */
export function readTodos(sessionId: string): Todo[] {
  let db;
  try {
    db = new DatabaseSync(sessionDatabase(sessionId), { readOnly: true });
  } catch {
    return [];
  }

  try {
    // Oldest first, which is the order they were planned in and the order the CLI draws
    // them. The runtime's own reader orders by the same column.
    const rows = db.prepare('SELECT id, title, description, status FROM todos ORDER BY created_at').all();

    const listed = new Set(rows.flatMap((row) => (typeof row.id === 'string' ? [row.id] : [])));
    const waitsOn = new Map<string, string[]>();
    // Read separately, and allowed to fail on its own: a session whose edges table is
    // missing still has a list worth drawing, which is why the runtime reads the two
    // independently too.
    try {
      for (const edge of db.prepare('SELECT todo_id, depends_on FROM todo_deps').all()) {
        const from = edge.todo_id;
        const to = edge.depends_on;
        if (typeof from !== 'string' || typeof to !== 'string') continue;
        // An edge naming something that is not in the list could only be drawn as a bare
        // id, which says nothing to anybody.
        if (!listed.has(from) || !listed.has(to)) continue;
        waitsOn.set(from, [...(waitsOn.get(from) ?? []), to]);
      }
    } catch {
      // No edges, which is a list without dependencies rather than a list without rows.
    }

    return rows.flatMap((row) => {
      // An id is what an edge points at, and what tells two untitled rows apart.
      if (typeof row.id !== 'string') return [];

      return [
        {
          id: row.id,
          // Untitled rather than dropped: it still has a status and a place in the order,
          // and leaving it out would make the list disagree with what the agent is
          // working through.
          title: typeof row.title === 'string' ? row.title : '',
          status: typeof row.status === 'string' ? row.status : '',
          ...(typeof row.description === 'string' && row.description ? { description: row.description } : {}),
          dependsOn: waitsOn.get(row.id) ?? [],
        },
      ];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}
