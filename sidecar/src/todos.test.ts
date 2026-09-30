import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

vi.mock('./paths.js', () => ({
  sessionDatabase: (sessionId: string) => join(home, 'session-state', sessionId, 'session.db'),
}));

const { readTodos } = await import('./todos.js');

/** The schema the runtime gives the agent, as the `sql` tool creates it. */
function makeDb(sessionId: string, build: (db: DatabaseSync) => void): void {
  const dir = join(home, 'session-state', sessionId);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'session.db'));
  db.exec(`CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE TABLE todo_deps (todo_id TEXT NOT NULL, depends_on TEXT NOT NULL)');
  build(db);
  db.close();
}

const add = (db: DatabaseSync, id: string, over: Record<string, string> = {}) =>
  db
    .prepare('INSERT INTO todos (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, over.title ?? `Todo ${id}`, over.description ?? null, over.status ?? 'pending', over.created_at ?? `2026-01-01 00:00:0${id.length}`);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'todos-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * The agent's own todo list, read from the session's database (#172).
 *
 * Read from the file rather than asked of the runtime, which is the whole difference
 * between a list that appears and one that does not: the runtime's own reader needs the
 * session loaded, and this app loads nothing until asked.
 */
describe('reading the agent’s todo list', () => {
  it('says nothing for a session that has no database', () => {
    expect(readTodos('never-ran')).toEqual([]);
  });

  it('says nothing for a database with no todos table', () => {
    const dir = join(home, 'session-state', 's1');
    mkdirSync(dir, { recursive: true });
    new DatabaseSync(join(dir, 'session.db')).close();

    expect(readTodos('s1')).toEqual([]);
  });

  it('says nothing rather than failing on a file that is not a database', () => {
    const dir = join(home, 'session-state', 's1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.db'), 'not a database at all');

    expect(readTodos('s1')).toEqual([]);
  });

  /** The case that started this: a session nobody has woken still has a list. */
  it('reads a list without the session being loaded', () => {
    makeDb('s1', (db) => add(db, 'a', { title: 'Read the log', description: 'from the end', status: 'in_progress' }));

    expect(readTodos('s1')).toEqual([
      { id: 'a', title: 'Read the log', description: 'from the end', status: 'in_progress', dependsOn: [] },
    ]);
  });

  it('puts them in the order they were planned', () => {
    makeDb('s1', (db) => {
      add(db, 'b', { created_at: '2026-01-01 00:00:02' });
      add(db, 'a', { created_at: '2026-01-01 00:00:01' });
      add(db, 'c', { created_at: '2026-01-01 00:00:03' });
    });

    expect(readTodos('s1').map((todo) => todo.id)).toEqual(['a', 'b', 'c']);
  });

  it('joins an edge onto the todo that waits on it', () => {
    makeDb('s1', (db) => {
      add(db, 'a');
      add(db, 'b');
      db.prepare('INSERT INTO todo_deps (todo_id, depends_on) VALUES (?, ?)').run('b', 'a');
    });

    expect(readTodos('s1').map((todo) => todo.dependsOn)).toEqual([[], ['a']]);
  });

  it('keeps every edge a todo waits on', () => {
    makeDb('s1', (db) => {
      add(db, 'a');
      add(db, 'b');
      add(db, 'c');
      const edge = db.prepare('INSERT INTO todo_deps (todo_id, depends_on) VALUES (?, ?)');
      edge.run('c', 'a');
      edge.run('c', 'b');
    });

    expect(readTodos('s1')[2]?.dependsOn).toEqual(['a', 'b']);
  });

  /** An edge to something absent could only be drawn as a bare id. */
  it('drops an edge naming a todo that is not listed', () => {
    makeDb('s1', (db) => {
      add(db, 'a');
      db.prepare('INSERT INTO todo_deps (todo_id, depends_on) VALUES (?, ?)').run('a', 'gone');
    });

    expect(readTodos('s1')[0]?.dependsOn).toEqual([]);
  });

  /** A list without dependencies is still a list worth drawing. */
  it('still reads the rows when the edges table is missing', () => {
    const dir = join(home, 'session-state', 's1');
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'session.db'));
    db.exec("CREATE TABLE todos (id TEXT, title TEXT, description TEXT, status TEXT, created_at TEXT)");
    db.prepare('INSERT INTO todos VALUES (?, ?, ?, ?, ?)').run('a', 'Alone', null, 'pending', '2026-01-01 00:00:01');
    db.close();

    expect(readTodos('s1')).toEqual([{ id: 'a', title: 'Alone', status: 'pending', dependsOn: [] }]);
  });

  it('leaves out a description the row did not have', () => {
    makeDb('s1', (db) => add(db, 'a'));

    expect('description' in readTodos('s1')[0]!).toBe(false);
  });

  /** Its own word, which may be one nobody here anticipated. */
  it('passes a status through rather than mapping it', () => {
    makeDb('s1', (db) => add(db, 'a', { status: 'deferred' }));

    expect(readTodos('s1')[0]?.status).toBe('deferred');
  });

  it('says nothing for a table that has no rows yet', () => {
    makeDb('s1', () => undefined);

    expect(readTodos('s1')).toEqual([]);
  });

  /** Opened read-only, so nothing here can damage what a live session is writing to. */
  it('leaves the database as it found it', () => {
    makeDb('s1', (db) => add(db, 'a'));
    readTodos('s1');

    const db = new DatabaseSync(join(home, 'session-state', 's1', 'session.db'), { readOnly: true });
    expect(db.prepare('SELECT count(*) AS n FROM todos').get()!.n).toBe(1);
    db.close();
  });
});
