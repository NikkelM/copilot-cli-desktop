import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Names read from disk, so a cache that promises not to read twice can be held to it.
 *
 * Counting the reads is the only honest test of that promise: trying to change a file while
 * leaving it looking untouched fails, because restoring a modification time cannot reproduce
 * its sub-millisecond part, which the cache compares.
 */
const reads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: actual,
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      reads.push(String(path));
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

/**
 * Build a throwaway .copilot directory with the CLI's real schema.
 *
 * Exercising actual SQL against a real database is the point: every bug in this area so
 * far has been about which column or file the data was taken from, which a stubbed
 * data layer would not have caught.
 */
function makeStore() {
  const home = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  const db = new DatabaseSync(join(home, 'session-store.db'));

  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT,
      summary TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
      user_message TEXT, assistant_response TEXT, timestamp TEXT
    );
  `);

  return {
    home,
    addSession(id: string, fields: Partial<Record<string, string | null>> = {}) {
      db.prepare(
        `INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        (fields.cwd ?? null) as string | null,
        (fields.repository ?? null) as string | null,
        (fields.branch ?? null) as string | null,
        (fields.summary ?? null) as string | null,
        fields.created_at ?? '2026-01-01 00:00:00',
        fields.updated_at ?? '2026-01-01 00:00:00',
      );

      // A real session is a row and a directory. Seeding only the row would describe one
      // that has been deleted, which is a case worth testing deliberately rather than by
      // accident in every other test.
      const dir = join(home, 'session-state', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), '{}\n');
    },
    /** Take away only the log, as a session that has not had a turn yet. */
    removeLog(sessionId: string) {
      rmSync(join(home, 'session-state', sessionId, 'events.jsonl'), { force: true });
    },
    /** Take away a session's log, as deleting it outside the app would. */
    removeState(sessionId: string) {
      rmSync(join(home, 'session-state', sessionId), { recursive: true, force: true });
    },
    addTurn(sessionId: string, index: number, user: string | null, assistant: string | null, timestamp: string) {
      db.prepare(
        `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(sessionId, index, user, assistant, timestamp);
    },
    /** Write the per-session state the CLI keeps outside the database. */
    addState(sessionId: string, { name, logMtime }: { name?: string; logMtime?: Date } = {}) {
      const dir = join(home, 'session-state', sessionId);
      mkdirSync(dir, { recursive: true });
      if (name !== undefined) {
        writeFileSync(join(dir, 'workspace.yaml'), `id: ${sessionId}\nname: ${name}\nuser_named: true\n`);
      }
      // Every real session has one, and its absence is what marks a session as no longer
      // openable, so writing it is part of existing rather than an option.
      const log = join(dir, 'events.jsonl');
      writeFileSync(log, '{}\n');
      if (logMtime) utimesSync(log, logMtime, logMtime);
    },
    /** Take the name file away, as deleting or never writing it would. */
    removeName(sessionId: string) {
      rmSync(join(home, 'session-state', sessionId, 'workspace.yaml'), { force: true });
    },
    close() {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

type Store = ReturnType<typeof makeStore>;
let store: Store;

/** paths.ts reads COPILOT_HOME once at import, so the module cache must be cleared. */
async function loadIndex() {
  vi.resetModules();
  process.env.COPILOT_HOME = store.home;
  return import('./sessionIndex.js');
}

beforeEach(() => {
  store = makeStore();
});

afterEach(() => {
  store.close();
  delete process.env.COPILOT_HOME;
});

describe('listSessions', () => {

  /**
   * The database and the logs are separate things. Deleting a session's directory, or
   * restoring a machine without it, leaves a row that still has a summary and turns - so
   * it looks like a session until it is opened, at which point the transcript is empty and
   * resuming it fails.
   */

  /**
   * A session that has only just been started has no title and no turns, which is exactly
   * how the database describes a crashed start. Judging it on that alone made a new
   * session vanish the moment it was made, with the button appearing to do nothing.
   */
  it('keeps a session the runtime is holding, however empty it looks', async () => {
    store.addSession('fresh');

    const { listSessions } = await loadIndex();
    expect(listSessions().map((s) => s.sessionId)).toEqual([]);
    expect(listSessions(['fresh']).map((s) => s.sessionId)).toEqual(['fresh']);
  });

  it('does not list a held session twice', async () => {
    store.addSession('used', { summary: 'Has a name' });
    store.addTurn('used', 0, 'hi', 'hello', '2026-09-05 10:00:00');

    const { listSessions } = await loadIndex();
    expect(listSessions(['used']).map((s) => s.sessionId)).toEqual(['used']);
  });

  /**
   * A session's log is written on its first turn, so one just started has none. Judging it
   * missing rather than not-yet-written hid every new session behind a second filter.
   */
  it('keeps a held session that has not written its log yet', async () => {
    store.addSession('fresh');
    store.removeLog('fresh');

    const { listSessions } = await loadIndex();
    expect(listSessions().map((s) => s.sessionId)).toEqual([]);
    expect(listSessions(['fresh']).map((s) => s.sessionId)).toEqual(['fresh']);
  });
  it('hides a session whose log has gone', async () => {
    store.addSession('kept', { summary: 'Still here' });
    store.addTurn('kept', 0, 'hello', 'hi', '2026-01-02 10:00:00');
    store.addSession('deleted', { summary: 'Was here' });
    store.addTurn('deleted', 0, 'hello', 'hi', '2026-01-02 11:00:00');
    store.removeState('deleted');

    const { listSessions } = await loadIndex();
    expect(listSessions().map((s) => s.sessionId)).toEqual(['kept']);
  });
  it('hides sessions with neither a title nor any turns', async () => {
    store.addSession('empty');
    store.addSession('titled', { summary: 'Has a name' });
    store.addSession('used');
    store.addTurn('used', 0, 'hi', 'hello', '2026-09-05 10:00:00');

    const { listSessions } = await loadIndex();
    expect(listSessions().map((s) => s.sessionId).sort()).toEqual(['titled', 'used']);
  });

  it('prefers the workspace name over the database summary', async () => {
    store.addSession('renamed', { summary: 'Auto generated from first message' });
    store.addTurn('renamed', 0, 'x', 'y', '2026-09-05 10:00:00');
    store.addState('renamed', { name: 'HadesBiomes mod issues' });

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.title).toBe('HadesBiomes mod issues');
  });

  it('unquotes names containing a colon', async () => {
    store.addSession('quoted', { summary: 'fallback' });
    store.addTurn('quoted', 0, 'x', 'y', '2026-09-05 10:00:00');
    store.addState('quoted', { name: "'Reply with exactly: PONG'" });

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.title).toBe('Reply with exactly: PONG');
  });

  it('falls back to the summary when there is no workspace file', async () => {
    store.addSession('bare', { summary: 'Only a summary' });
    store.addTurn('bare', 0, 'x', 'y', '2026-09-05 10:00:00');

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.title).toBe('Only a summary');
  });

  it('previews the newest turn, preferring the assistant reply', async () => {
    store.addSession('s', { summary: 'S' });
    store.addTurn('s', 0, 'first', 'old reply', '2026-09-05 10:00:00');
    store.addTurn('s', 1, 'second', 'newest reply', '2026-09-05 11:00:00');

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.preview).toBe('newest reply');
  });

  it('falls back to the user message when the assistant has not replied', async () => {
    store.addSession('s', { summary: 'S' });
    store.addTurn('s', 0, 'only a question', null, '2026-09-05 10:00:00');

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.preview).toBe('only a question');
  });

  // sessions.updated_at is written at creation, not per turn, so it was hours stale.
  it('ignores the stale updated_at column in favour of real activity', async () => {
    store.addSession('s', { summary: 'S', updated_at: '2020-01-01 00:00:00' });
    store.addTurn('s', 0, 'x', 'y', '2026-09-05 10:00:00');

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.updatedAt).toContain('2026');
  });

  it('sorts by most recent activity', async () => {
    store.addSession('old', { summary: 'Old' });
    store.addTurn('old', 0, 'x', 'y', '2026-09-05 09:00:00');
    store.addSession('new', { summary: 'New' });
    store.addTurn('new', 0, 'x', 'y', '2026-09-05 12:00:00');

    const { listSessions } = await loadIndex();
    expect(listSessions().map((s) => s.sessionId)).toEqual(['new', 'old']);
  });
});

/**
 * The list hides sessions with no title and no turns because almost all of them are crashed
 * starts - 99 of 182 on a real store. But an id typed into the filter names one session, and
 * answering "no sessions match" for one that is sitting on disk reads as data loss.
 */
describe('findSessions', () => {
  it('finds a session the list hides', async () => {
    store.addSession('0bd2d807-816c-46ce-8e8e-20c74b9be864');

    const { findSessions, listSessions } = await loadIndex();
    expect(listSessions().map((s) => s.sessionId)).toEqual([]);
    expect(findSessions('0bd2d807').map((s) => s.sessionId)).toEqual([
      '0bd2d807-816c-46ce-8e8e-20c74b9be864',
    ]);
  });

  // Ids are quoted by their first characters, in CLI output and in directory names.
  it('matches from the start rather than anywhere', async () => {
    store.addSession('0bd2d807-816c-46ce-8e8e-20c74b9be864');

    const { findSessions } = await loadIndex();
    expect(findSessions('816c')).toEqual([]);
  });

  it('ignores the case the id was typed in', async () => {
    store.addSession('0bd2d807-816c-46ce-8e8e-20c74b9be864');

    const { findSessions } = await loadIndex();
    expect(findSessions('0BD2D807').map((s) => s.sessionId)).toHaveLength(1);
  });

  /**
   * LIKE treats _ and % as patterns, so an unescaped query would match ids it was not
   * asked about - `_` alone would match every session whose id has any first character.
   */
  it('takes wildcards in the query literally', async () => {
    store.addSession('abcdef00-0000-0000-0000-000000000000');

    const { findSessions } = await loadIndex();
    expect(findSessions('_bcdef')).toEqual([]);
    expect(findSessions('%')).toEqual([]);
  });

  // Same rule as the list: a row whose directory is gone describes a session that cannot
  // be opened, so offering it promises something the transcript cannot deliver.
  it('leaves out a session whose log is gone', async () => {
    store.addSession('deadbeef-0000-0000-0000-000000000000');
    store.removeState('deadbeef-0000-0000-0000-000000000000');

    const { findSessions } = await loadIndex();
    expect(findSessions('deadbeef')).toEqual([]);
  });

  it('says nothing for an empty query rather than everything', async () => {
    store.addSession('abcdef00-0000-0000-0000-000000000000');

    const { findSessions } = await loadIndex();
    expect(findSessions('')).toEqual([]);
    expect(findSessions('   ')).toEqual([]);
  });

  it('finds listed sessions too, so a match never depends on which side it is on', async () => {
    store.addSession('abcdef00-0000-0000-0000-000000000000', { summary: 'Named' });
    store.addTurn('abcdef00-0000-0000-0000-000000000000', 0, 'x', 'y', '2026-09-05 09:00:00');

    const { findSessions } = await loadIndex();
    expect(findSessions('abcdef').map((s) => s.sessionId)).toHaveLength(1);
  });
});

/**
 * Reading `workspace.yaml` for every session was 49ms of a 113ms refresh, on the app's
 * hottest path. It is now read only when the file differs from what was read last - which
 * is only correct if a change is actually noticed.
 */
describe('the session name cache', () => {
  it('shows a name that changed since it was last read', async () => {
    store.addSession('renamed', { summary: 'Auto summary' });
    store.addTurn('renamed', 0, 'x', 'y', '2026-09-05 09:00:00');
    store.addState('renamed', { name: 'Before' });

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.title).toBe('Before');

    store.addState('renamed', { name: 'After' });
    expect(listSessions()[0]?.title).toBe('After');
  });

  // Two names of the same length written in the same millisecond would look identical to a
  // check on mtime alone, so the size is not enough on its own either - but a rename that
  // keeps both is the pathological case, not the normal one.
  it('notices a name of a different length', async () => {
    store.addSession('renamed', { summary: 'Auto summary' });
    store.addTurn('renamed', 0, 'x', 'y', '2026-09-05 09:00:00');
    store.addState('renamed', { name: 'Short' });

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.title).toBe('Short');

    store.addState('renamed', { name: 'Considerably longer than before' });
    expect(listSessions()[0]?.title).toBe('Considerably longer than before');
  });

  it('falls back to the summary when the name file is taken away', async () => {
    store.addSession('unnamed', { summary: 'Auto summary' });
    store.addTurn('unnamed', 0, 'x', 'y', '2026-09-05 09:00:00');
    store.addState('unnamed', { name: 'Named' });

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.title).toBe('Named');

    store.removeName('unnamed');
    expect(listSessions()[0]?.title).toBe('Auto summary');
  });

  it('does not read the file again while it looks unchanged', async () => {
    store.addSession('stable', { summary: 'Auto summary' });
    store.addTurn('stable', 0, 'x', 'y', '2026-09-05 09:00:00');
    store.addState('stable', { name: 'Stable' });

    const { listSessions } = await loadIndex();
    expect(listSessions()[0]?.title).toBe('Stable');

    const after = reads.filter((path) => path.includes('workspace.yaml')).length;
    listSessions();
    listSessions();
    listSessions();

    expect(reads.filter((path) => path.includes('workspace.yaml'))).toHaveLength(after);
  });
});

describe('lastActivity', () => {
  // The turns table is flushed late; for a session this app holds open it was measured
  // eight minutes behind the event log.
  it('prefers the event log when it is newer than the newest turn', async () => {
    const recent = new Date('2026-09-05T15:11:00Z');
    store.addState('s', { logMtime: recent });

    const { lastActivity } = await loadIndex();
    expect(lastActivity('s', '2026-09-05 15:04:00')).toBe(recent.toISOString());
  });

  it('keeps the turn timestamp when the log is older', async () => {
    store.addState('s', { logMtime: new Date('2026-09-05T09:00:00Z') });

    const { lastActivity } = await loadIndex();
    expect(lastActivity('s', '2026-09-05 15:00:00')).toBe('2026-09-05 15:00:00');
  });

  it('falls back to the turn timestamp when there is no log', async () => {
    const { lastActivity } = await loadIndex();
    expect(lastActivity('missing', '2026-09-05 10:00:00')).toBe('2026-09-05 10:00:00');
  });

  it('returns null when neither source knows anything', async () => {
    const { lastActivity } = await loadIndex();
    expect(lastActivity('missing', null)).toBeNull();
  });
});
