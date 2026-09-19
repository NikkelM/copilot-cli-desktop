import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const opens = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: actual,
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      reads.push(String(path));
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
    openSync: (path: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
      opens.push(String(path));
      return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
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
    /** Leave the log in place with nothing in it, as a start that wrote no events does. */
    emptyLog(sessionId: string) {
      writeFileSync(join(home, 'session-state', sessionId, 'events.jsonl'), '');
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
    addState(
      sessionId: string,
      {
        name,
        logMtime,
        cwd,
        repository,
        branch,
        workspace,
        userNamed,
      }: {
        name?: string;
        logMtime?: Date;
        cwd?: string;
        repository?: string;
        branch?: string;
        /** Write the file with only what is named, as a session outside a repository has. */
        workspace?: boolean;
        /**
         * Whether the name was somebody's choosing. A session the CLI named itself carries
         * the name without the flag, which is the state a rename has to correct.
         */
        userNamed?: boolean;
      } = {},
    ) {
      const dir = join(home, 'session-state', sessionId);
      mkdirSync(dir, { recursive: true });
      const named = name !== undefined || cwd !== undefined || repository !== undefined || branch !== undefined;
      if (named || workspace) {
        const lines = [`id: ${sessionId}`];
        if (cwd !== undefined) lines.push(`cwd: ${cwd}`);
        if (repository !== undefined) lines.push(`repository: ${repository}`);
        if (branch !== undefined) lines.push(`branch: ${branch}`);
        if (name !== undefined) {
          lines.push(`name: ${name}`);
          // The CLI writes the flag either way, so a session it named itself carries a false
          // rather than nothing. Renaming has to overwrite that line, not add a second.
          lines.push(`user_named: ${userNamed !== false}`);
        }
        writeFileSync(join(dir, 'workspace.yaml'), `${lines.join('\n')}\n`);
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
    /** Write a session's log the way the CLI does, one JSON event to a line. */
    writeLog(sessionId: string, events: readonly unknown[]) {
      const dir = join(home, 'session-state', sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
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

  /**
   * The exemption above is for a log not written yet, not for a session that has gone. One
   * whose directory was deleted while the runtime held it used to stay in the list forever,
   * failing every time it was opened (#141).
   */
  it('drops a held session whose state directory has gone', async () => {
    store.addSession('vanished', { summary: 'Was here' });
    store.addTurn('vanished', 0, 'hi', 'hello', '2026-09-05 10:00:00');
    store.removeState('vanished');

    const { listSessions } = await loadIndex();
    expect(listSessions(['vanished']).map((s) => s.sessionId)).toEqual([]);
  });

  /** Resuming one of these fails with "Cannot create session from empty events array". */
  it('treats an empty log as no log at all', async () => {
    store.addSession('blank', { summary: 'Looks real' });
    store.addTurn('blank', 0, 'hi', 'hello', '2026-09-05 10:00:00');
    store.emptyLog('blank');

    const { listSessions } = await loadIndex();
    expect(listSessions().map((s) => s.sessionId)).toEqual([]);
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

describe('existingSessions', () => {
  it('keeps the ones whose state directory is still there', async () => {
    store.addSession('alive');
    store.addSession('deleted');
    store.removeState('deleted');

    const { existingSessions } = await loadIndex();
    expect(existingSessions(['alive', 'deleted'])).toEqual(['alive']);
  });

  /**
   * A session that has not had a turn yet has no log, and a session started and abandoned
   * has an empty one. Both are hidden from the list, and neither has been deleted, so what
   * the app remembers about them must survive.
   */
  it('counts a session with no usable log as still there', async () => {
    store.addSession('fresh');
    store.removeLog('fresh');
    store.addSession('blank');
    store.emptyLog('blank');

    const { existingSessions } = await loadIndex();
    expect(existingSessions(['fresh', 'blank'])).toEqual(['fresh', 'blank']);
  });

  it('has nothing to say about an id it was never given', async () => {
    const { existingSessions } = await loadIndex();
    expect(existingSessions([])).toEqual([]);
    expect(existingSessions(['never-existed'])).toEqual([]);
  });
});

/**
 * Where the sidebar's repository, branch and directory come from.
 *
 * The database is written once and not corrected, so it can name a repository a session has
 * nothing to do with. Across a real store, 29 rows named one where the session's own
 * workspace named none, 28 of them for a session whose directory is not a repository at all.
 */
describe('what a session says about its workspace', () => {
  it('takes the repository from the session, not from the database', async () => {
    const { listSessions } = await loadIndex();
    store.addSession('s1', { repository: 'someone/stale', branch: 'old', summary: 'A session' });
    store.addState('s1', { cwd: '/work/real', repository: 'me/real', branch: 'main' });

    const [session] = listSessions();
    expect(session?.repository).toBe('me/real');
    expect(session?.branch).toBe('main');
    expect(session?.cwd).toBe('/work/real');
  });

  it('shows no repository when the session says it has none', async () => {
    // The case that started this: a session working in a plain folder, with a row naming a
    // repository it never touched.
    const { listSessions } = await loadIndex();
    store.addSession('s1', { repository: 'AnthonyBloomer/daftlistings', summary: 'Dublin House Hunting' });
    store.addState('s1', { cwd: '/home/me/Projects', name: 'Dublin House Hunting' });

    const [session] = listSessions();
    expect(session?.repository).toBeNull();
    expect(session?.branch).toBeNull();
    expect(session?.cwd).toBe('/home/me/Projects');
  });

  it('falls back to the database when the session has no workspace file', async () => {
    // A session old enough to predate the file still has to say something.
    const { listSessions } = await loadIndex();
    store.addSession('s1', { cwd: '/work/old', repository: 'me/old', branch: 'main', summary: 'A session' });

    const [session] = listSessions();
    expect(session?.repository).toBe('me/old');
    expect(session?.branch).toBe('main');
    expect(session?.cwd).toBe('/work/old');
  });

  it('still prefers the name the session was given', async () => {
    const { listSessions } = await loadIndex();
    store.addSession('s1', { summary: 'Auto-generated' });
    store.addState('s1', { name: 'What I called it' });

    expect(listSessions()[0]?.title).toBe('What I called it');
  });

  it('answers the same for a session found by id', async () => {
    const { findSessions } = await loadIndex();
    store.addSession('11111111-1111-1111-1111-111111111111', { repository: 'someone/stale', summary: 'Found' });
    store.addState('11111111-1111-1111-1111-111111111111', { cwd: '/work/real', repository: 'me/real' });

    const [session] = findSessions('11111111');
    expect(session?.repository).toBe('me/real');
  });
});

/**
 * There is no RPC for renaming: the CLI does it through an in-process native binding, so the
 * only way to give a session a name the CLI will also show is to write the file it reads.
 * Tested against a real store first - a name written this way survived the CLI taking another
 * turn on the same session.
 */

/**
 * There is no RPC for renaming: the CLI does it through an in-process native binding, so the
 * only way to give a session a name the CLI will also show is to write the file it reads.
 * Tested against a real store before it was written - a name put there by hand survived the
 * CLI taking another turn on the same session, with the CLI rewriting the rest of the file.
 */
describe('naming a session', () => {
  /** What the file says now. */
  const workspaceOf = (sessionId: string) =>
    readFileSync(join(store.home, 'session-state', sessionId, 'workspace.yaml'), 'utf8');

  it('writes the name where the CLI reads it', async () => {
    const { listSessions, renameSession } = await loadIndex();
    store.addSession('s1', { summary: 'Auto-generated' });
    store.addState('s1', { name: 'What it was called' });

    renameSession('s1', 'What I called it');

    expect(listSessions()[0]?.title).toBe('What I called it');
  });

  it('says the name was somebody choice, or the CLI makes up another later', async () => {
    // Ten of the fourteen named sessions on a real machine were auto-named first, so the
    // flag is what stops the next summary overwriting the name. The session here is in that
    // state: named by the CLI, and so carrying no flag of its own yet.
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { name: 'Auto', userNamed: false });
    expect(workspaceOf('s1')).toMatch(/^user_named: false$/m);

    renameSession('s1', 'Chosen');

    expect(workspaceOf('s1')).toMatch(/^user_named:\s*true$/m);
  });

  it('gives a session one name rather than a second one', async () => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { name: 'Before' });

    renameSession('s1', 'After');
    renameSession('s1', 'After again');

    const lines = workspaceOf('s1').split('\n');
    expect(lines.filter((line) => line.startsWith('name:'))).toEqual(['name: After again']);
    expect(lines.filter((line) => line.startsWith('user_named:'))).toHaveLength(1);
  });

  it('names one the CLI never named', async () => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { workspace: true });

    renameSession('s1', 'First name');

    expect(workspaceOf('s1')).toMatch(/^name:\s*First name$/m);
  });

  it('leaves everything else in the file alone', async () => {
    const { listSessions, renameSession } = await loadIndex();
    // A summary, since a session with neither that nor a turn is left out of the list.
    store.addSession('s1', { summary: 'Something' });
    store.addState('s1', { name: 'Before', cwd: '/work/here', repository: 'me/thing', branch: 'main' });

    renameSession('s1', 'After');

    const [session] = listSessions();
    expect(session?.cwd).toBe('/work/here');
    expect(session?.repository).toBe('me/thing');
    expect(session?.branch).toBe('main');
  });

  it('quotes a name that would otherwise read as something else', async () => {
    const { listSessions, renameSession } = await loadIndex();
    store.addSession('s1', { summary: 'Something' });
    store.addState('s1', { name: 'Before' });

    renameSession('s1', 'Reply with exactly: PONG');

    expect(workspaceOf('s1')).toContain("name: 'Reply with exactly: PONG'");
    // And reads back as what was asked for, rather than as the quoting.
    expect(listSessions()[0]?.title).toBe('Reply with exactly: PONG');
  });

  it('survives a name carrying the quote it would be wrapped in', async () => {
    const { listSessions, renameSession } = await loadIndex();
    store.addSession('s1', { summary: 'Something' });
    store.addState('s1', { name: 'Before' });

    renameSession('s1', "Nikkel's: sessions");

    // Doubled on the way out, which is YAML's own escape. Reading it back is not proof on
    // its own: the reader's match is greedy, so it happens to undo an unescaped quote too.
    expect(workspaceOf('s1')).toContain("name: 'Nikkel''s: sessions'");
    expect(listSessions()[0]?.title).toBe("Nikkel's: sessions");
  });

  it('leaves a plain name unquoted, since most names are plain', async () => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { name: 'Before' });

    renameSession('s1', 'Revamp Personal Website');

    expect(workspaceOf('s1')).toMatch(/^name: Revamp Personal Website$/m);
  });

  it.each([
    ['nothing at all', ''],
    ['only space', '   '],
  ])('refuses %s', async (_what, name) => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { name: 'Before' });

    expect(() => renameSession('s1', name)).toThrow(/needs a name/i);
  });

  it('refuses one that would span lines, which would be a different file', async () => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { name: 'Before' });

    expect(() => renameSession('s1', 'one\nuser_named: false')).toThrow(/span lines/i);
  });

  it('refuses one longer than the CLI would take', async () => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { name: 'Before' });

    expect(() => renameSession('s1', 'x'.repeat(201))).toThrow(/at most/i);
  });

  it('says so rather than inventing a workspace for a session too old to have one', async () => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.removeState('s1');

    expect(() => renameSession('s1', 'Anything')).toThrow(/no workspace/i);
  });

  it('leaves the file it had when the write fails partway', async () => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { name: 'Before' });
    const dir = join(store.home, 'session-state', 's1');
    // A directory where the temporary file wants to be, so writing it cannot succeed. The
    // point is what the session is left with: writing in place would have truncated it.
    mkdirSync(join(dir, 'workspace.yaml.writing'));

    expect(() => renameSession('s1', 'After')).toThrow();

    expect(workspaceOf('s1')).toMatch(/^name: Before$/m);
  });

  it('leaves no temporary file behind', async () => {
    const { renameSession } = await loadIndex();
    store.addSession('s1', {});
    store.addState('s1', { name: 'Before' });

    renameSession('s1', 'After');

    const dir = join(store.home, 'session-state', 's1');
    expect(readdirSync(dir).filter((f) => f.endsWith('.writing'))).toEqual([]);
  });
});