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
