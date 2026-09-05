import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      if (logMtime) {
        const log = join(dir, 'events.jsonl');
        writeFileSync(log, '{}\n');
        utimesSync(log, logMtime, logMtime);
      }
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
