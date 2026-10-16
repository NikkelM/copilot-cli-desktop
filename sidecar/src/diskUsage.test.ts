import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../../shared/protocol.js';

let home: string;

/**
 * The session store, stubbed so a test can say what the sidebar knows without a database.
 * What matters here is the directories, which are the thing disk usage is about.
 */
const { listSessions } = vi.hoisted(() => ({ listSessions: vi.fn((): SessionSummary[] => []) }));
vi.mock('./sessionIndex.js', () => ({ listSessions }));

async function load() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./diskUsage.js');
}

/** A session directory holding a log of a given size, and optionally a pile of backups. */
function makeSession(sessionId: string, logBytes: number, backups: number[] = []): void {
  const dir = join(home, 'session-state', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), 'x'.repeat(logBytes));

  if (backups.length > 0) {
    mkdirSync(join(dir, 'backups'), { recursive: true });
    backups.forEach((size, index) => writeFileSync(join(dir, 'backups', `b${index}`), 'x'.repeat(size)));
  }
}

const summary = (sessionId: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId,
  title: `Session ${sessionId}`,
  cwd: null,
  repository: null,
  branch: null,
  updatedAt: '2026-01-02T03:04:05.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  loaded: false,
  ...over,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccd-disk-'));
  listSessions.mockReset().mockReturnValue([]);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

describe('what each session is using', () => {
  it('says nothing when the CLI has never run', async () => {
    const { sessionDiskUsage } = await load();

    expect(await sessionDiskUsage()).toEqual([]);
  });

  describe('measuring just one session', () => {
    it('counts its log and nested backups without consulting the session index', async () => {
      makeSession('chosen', 100, [200, 300]);
      makeSession('other', 9000);
      const { singleSessionDiskUsage } = await load();

      expect(await singleSessionDiskUsage('chosen')).toEqual({
        bytes: 600, files: 3, logBytes: 100, rewindBytes: 0, otherBytes: 500,
        directory: join(home, 'session-state', 'chosen'),
      });
      expect(listSessions).not.toHaveBeenCalled();
    });

    it('measures fresh after the session grows', async () => {
      makeSession('chosen', 100);
      const { singleSessionDiskUsage } = await load();
      expect((await singleSessionDiskUsage('chosen')).bytes).toBe(100);
      makeSession('chosen', 200);
      expect((await singleSessionDiskUsage('chosen')).bytes).toBe(200);
    });

    it('counts a session with no saved files as zero', async () => {
      const { singleSessionDiskUsage } = await load();
      expect(await singleSessionDiskUsage('unsaved')).toMatchObject({
        bytes: 0, files: 0, logBytes: 0, rewindBytes: 0, otherBytes: 0,
      });
    });

    it('separates the root log, rewind snapshots and all remaining files in one walk', async () => {
      makeSession('chosen', 100, [40]);
      const root = join(home, 'session-state', 'chosen');
      mkdirSync(join(root, 'rewind-file-snapshots', 'nested'), { recursive: true });
      writeFileSync(join(root, 'rewind-file-snapshots', 'index.json'), 'x'.repeat(20));
      writeFileSync(join(root, 'rewind-file-snapshots', 'nested', 'events.jsonl'), 'x'.repeat(30));
      writeFileSync(join(root, 'session.db'), 'x'.repeat(10));
      const { singleSessionDiskUsage } = await load();

      expect(await singleSessionDiskUsage('chosen')).toEqual({
        bytes: 200, files: 5, logBytes: 100, rewindBytes: 50, otherBytes: 50, directory: root,
      });
    });

    it('reports filesystem errors rather than treating an unreadable path as empty', async () => {
      mkdirSync(join(home, 'session-state'), { recursive: true });
      writeFileSync(join(home, 'session-state', 'not-a-directory'), 'data');
      const { singleSessionDiskUsage } = await load();
      await expect(singleSessionDiskUsage('not-a-directory')).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it.each(['', '..', '..\\other', '../other', 'C:\\other', 'a/b'])('rejects invalid session id %j', async (id) => {
      const { singleSessionDiskUsage } = await load();
      await expect(singleSessionDiskUsage(id)).rejects.toThrow('Invalid session id');
    });
  });

  it('adds up what a session holds', async () => {
    makeSession('s1', 1000);
    const { sessionDiskUsage } = await load();

    expect((await sessionDiskUsage())[0]).toMatchObject({ sessionId: 's1', bytes: 1000 });
  });

  /**
   * The event log is most of a session but not all of it, and the sessions with the most
   * backups are not the ones with the longest logs - so counting only the log would put
   * them in the wrong order, which is the one thing a list ranked by size must not do.
   */
  it('counts what is in the folders under it too', async () => {
    makeSession('s1', 1000, [500, 500]);
    const { sessionDiskUsage } = await load();

    expect((await sessionDiskUsage())[0]?.bytes).toBe(2000);
  });

  it('puts the largest first', async () => {
    makeSession('small', 100);
    makeSession('huge', 9000);
    makeSession('middling', 3000);
    const { sessionDiskUsage } = await load();

    expect((await sessionDiskUsage()).map((session) => session.sessionId)).toEqual([
      'huge',
      'middling',
      'small',
    ]);
  });

  it('names a session the store still knows', async () => {
    makeSession('s1', 100);
    listSessions.mockReturnValue([summary('s1', { title: 'Wiki browser' })]);
    const { sessionDiskUsage } = await load();

    expect((await sessionDiskUsage())[0]).toMatchObject({ title: 'Wiki browser', listed: true });
  });

  /**
   * A directory the store has no row for still has its bytes, and nothing else in the app
   * would ever mention it - which makes it exactly the kind of thing this is for.
   */
  it('reports a directory the session list has forgotten', async () => {
    makeSession('orphan', 5000);
    const { sessionDiskUsage } = await load();

    expect((await sessionDiskUsage())[0]).toMatchObject({
      sessionId: 'orphan',
      title: null,
      listed: false,
    });
  });

  it('carries when a session was last used, for one the store knows', async () => {
    makeSession('s1', 100);
    listSessions.mockReturnValue([summary('s1', { updatedAt: '2026-05-06T07:08:09.000Z' })]);
    const { sessionDiskUsage } = await load();

    expect((await sessionDiskUsage())[0]?.updatedAt).toBe('2026-05-06T07:08:09.000Z');
  });

  it('says nothing about when a forgotten one was used', async () => {
    makeSession('orphan', 100);
    const { sessionDiskUsage } = await load();

    expect((await sessionDiskUsage())[0]?.updatedAt).toBeNull();
  });

  it('reports an empty session as costing nothing rather than leaving it out', async () => {
    mkdirSync(join(home, 'session-state', 'empty'), { recursive: true });
    const { sessionDiskUsage } = await load();

    expect(await sessionDiskUsage()).toEqual([
      { sessionId: 'empty', title: null, updatedAt: null, bytes: 0, listed: false },
    ]);
  });

  /** Sessions outnumber the batch it walks them in, so every one has to come back. */
  it('walks past the size of one batch', async () => {
    for (let at = 0; at < 70; at++) makeSession(`s${at}`, at + 1);
    const { sessionDiskUsage } = await load();

    const found = await sessionDiskUsage();
    expect(found).toHaveLength(70);
    expect(found[0]?.bytes).toBe(70);
  });

  it('ignores a file sitting beside the session directories', async () => {
    makeSession('s1', 100);
    writeFileSync(join(home, 'session-state', 'stray.txt'), 'not a session');
    const { sessionDiskUsage } = await load();

    expect((await sessionDiskUsage()).map((session) => session.sessionId)).toEqual(['s1']);
  });
});
