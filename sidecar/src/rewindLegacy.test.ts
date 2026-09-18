import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store the CLI wrote until late July, built by hand and read back.
 *
 * `paths.ts` reads COPILOT_HOME once at import, so the module cache is cleared per test.
 */
let home: string;
let work: string;

async function load() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./rewindLegacy.js');
}

beforeEach(() => {
  home = mkdtempSync(join(homedir(), '.ccd-legacy-'));
  work = mkdtempSync(join(homedir(), '.ccd-work-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

const storeDir = (session: string) => join(home, 'session-state', session, 'rewind-snapshots');

/** Git's own hash of some content, which is what this store records. */
const gitHash = (body: string) => {
  const content = Buffer.from(body, 'utf8');
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return `git-sha1:${createHash('sha1').update(Buffer.concat([header, content])).digest('hex')}`;
};

/** One file's entry, with its blob written where the store would have put it. */
function entry(session: string, body: string, gitStatus = ' M') {
  const hash = gitHash(body);
  const backupFile = `${hash.slice(9, 25)}-1783525852935`;
  mkdirSync(join(storeDir(session), 'backups'), { recursive: true });
  writeFileSync(join(storeDir(session), 'backups', backupFile), body);
  return { gitStatus, contentHash: hash, backupFile, size: body.length, mtime: '', mode: 33206 };
}

interface Snap {
  files: Record<string, ReturnType<typeof entry>>;
  gitCommit?: string;
  timestamp?: string;
}

function store(session: string, paths: Record<string, string>, snaps: Snap[], version = 1) {
  mkdirSync(storeDir(session), { recursive: true });
  writeFileSync(
    join(storeDir(session), 'index.json'),
    JSON.stringify({
      version,
      filePathMap: paths,
      snapshots: snaps.map((s, i) => ({
        snapshotId: `s${i}`,
        eventId: `e${i}`,
        userMessage: `message ${i}`,
        timestamp: s.timestamp ?? `2026-07-0${i + 1}T00:00:00.000Z`,
        fileCount: Object.keys(s.files).length,
        files: s.files,
        backupHashes: [],
        gitCommit: s.gitCommit ?? 'commit-a',
        workspaceLinesAdded: 0,
        workspaceLinesRemoved: 0,
      })),
    }),
  );
}

describe('reading the store the CLI wrote until late July', () => {
  it('says nothing about a session that has none', async () => {
    const { readLegacyRewind } = await load();
    expect(readLegacyRewind('missing')).toEqual([]);
  });

  /** Both stores say `1` and mean different things, so a number it does not know is refused. */
  it('refuses a version it does not know', async () => {
    store('s', { k: join(work, 'a.txt') }, [{ files: {} }], 2);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')).toEqual([]);
  });

  it('gives one turn per recorded message', async () => {
    store('s', { k: join(work, 'a.txt') }, [
      { files: { k: entry('s', 'one\n') } },
      { files: { k: entry('s', 'two\n') } },
    ]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')).toHaveLength(2);
  });

  it('carries the message that started the turn', async () => {
    store('s', {}, [{ files: {} }]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.userMessage).toBe('message 0');
  });

  /**
   * The difference that makes this a separate reader: a snapshot is the workspace before a
   * turn, so what the turn changed is the step from one to the next.
   */
  it('reads a change as the step between consecutive snapshots', async () => {
    const path = join(work, 'a.txt');
    store('s', { k: path }, [
      { files: { k: entry('s', 'before\n') } },
      { files: { k: entry('s', 'after\n') } },
    ]);
    const { readLegacyRewind } = await load();

    const change = readLegacyRewind('s')[0]?.files.k;
    expect(change?.preimage).toMatchObject({ contentHash: gitHash('before\n') });
    expect(change?.postimage).toMatchObject({ contentHash: gitHash('after\n') });
  });

  it('leaves a file alone that merely sat in the dirty set', async () => {
    store('s', { k: join(work, 'a.txt') }, [
      { files: { k: entry('s', 'same\n') } },
      { files: { k: entry('s', 'same\n') } },
    ]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files).toEqual({});
  });

  it('reads a file the agent created as created', async () => {
    const path = join(work, 'new.txt');
    writeFileSync(path, 'fresh\n');
    store('s', { k: path }, [{ files: {} }, { files: { k: entry('s', 'fresh\n', '??') } }]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files.k?.preimage).toEqual({ kind: 'absent' });
  });

  it('reads a staged addition as created too', async () => {
    // Present on disk, so a reader that did not recognise `A ` as new would fall through to
    // "existed before, contents unknown" and the two answers would differ.
    const path = join(work, 'new.txt');
    writeFileSync(path, 'fresh\n');
    store('s', { k: path }, [{ files: {} }, { files: { k: entry('s', 'fresh\n', 'A ') } }]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files.k?.preimage).toEqual({ kind: 'absent' });
  });

  /**
   * A file that was merely clean is not listed, and what a commit held is not in this
   * store, so the honest answer is that the earlier contents cannot be produced.
   */
  it('will not invent what a previously clean file held', async () => {
    const path = join(work, 'tracked.txt');
    writeFileSync(path, 'on disk\n');
    store('s', { k: path }, [{ files: {} }, { files: { k: entry('s', 'edited\n', ' M') } }]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files.k?.preimage).toEqual({ kind: 'skipped' });
  });

  /**
   * Committing takes a file out of the dirty set without changing a byte of it. Reading
   * that as a deletion would invent one after every commit.
   */
  it('keeps what a file held when a commit took it out of the dirty set', async () => {
    const path = join(work, 'a.txt');
    store('s', { k: path }, [
      { files: {}, gitCommit: 'commit-a' },
      { files: { k: entry('s', 'work\n', '??') }, gitCommit: 'commit-a' },
      { files: {}, gitCommit: 'commit-b' },
    ]);
    const { readLegacyRewind } = await load();

    const turns = readLegacyRewind('s');
    expect(turns[0]?.files.k?.postimage).toMatchObject({ contentHash: gitHash('work\n') });
  });

  // Nothing about the file changed in the turn that committed it, so that turn says nothing.
  it('reports no change for the turn that merely committed it', async () => {
    const path = join(work, 'a.txt');
    store('s', { k: path }, [
      { files: {}, gitCommit: 'commit-a' },
      { files: { k: entry('s', 'work\n', '??') }, gitCommit: 'commit-a' },
      { files: {}, gitCommit: 'commit-b' },
    ]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[1]?.files).toEqual({});
  });

  it('does not call a commit a deletion', async () => {
    const path = join(work, 'a.txt');
    store('s', { k: path }, [
      { files: {}, gitCommit: 'commit-a' },
      { files: { k: entry('s', 'work\n', '??') }, gitCommit: 'commit-a' },
      { files: {}, gitCommit: 'commit-b' },
    ]);
    const { readLegacyRewind } = await load();

    for (const turn of readLegacyRewind('s')) {
      expect(turn.files.k?.postimage.kind).not.toBe('absent');
    }
  });

  /** Clean without a commit is a revert, and what it reverted to is not recorded. */
  it('will not claim to know what a reverted file became', async () => {
    const path = join(work, 'a.txt');
    writeFileSync(path, 'reverted\n');
    store('s', { k: path }, [
      { files: { k: entry('s', 'work\n') }, gitCommit: 'commit-a' },
      { files: {}, gitCommit: 'commit-a' },
    ]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files.k?.postimage).toEqual({ kind: 'skipped' });
  });

  it('reads a file that went away without a commit as deleted', async () => {
    store('s', { k: join(work, 'gone.txt') }, [
      { files: { k: entry('s', 'work\n') }, gitCommit: 'commit-a' },
      { files: {}, gitCommit: 'commit-a' },
    ]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files.k?.postimage).toEqual({ kind: 'absent' });
  });

  /**
   * The store stops at the last message, so the newest turn's results were never written
   * down. The working tree is the only record of them.
   */
  it('ends the last turn at what the file holds now', async () => {
    const path = join(work, 'a.txt');
    writeFileSync(path, 'final\n');
    store('s', { k: path }, [{ files: { k: entry('s', 'earlier\n') } }]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files.k?.postimage).toMatchObject({ contentHash: gitHash('final\n') });
  });

  it('ends it at nothing when the file is gone', async () => {
    store('s', { k: join(work, 'gone.txt') }, [{ files: { k: entry('s', 'earlier\n') } }]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files.k?.postimage).toEqual({ kind: 'absent' });
  });

  it('names the blob the store gave, which is not its hash', async () => {
    const one = entry('s', 'before\n');
    store('s', { k: join(work, 'a.txt') }, [{ files: { k: one } }, { files: { k: entry('s', 'after\n') } }]);
    const { readLegacyRewind } = await load();

    const preimage = readLegacyRewind('s')[0]?.files.k?.preimage;
    expect(preimage).toMatchObject({ blob: one.backupFile });
    expect(one.backupFile).not.toBe(one.contentHash);
  });

  /** The snapshots carry no paths at all, only keys into a map at the top level. */
  it('skips a key the path map does not name', async () => {
    store('s', {}, [{ files: { k: entry('s', 'orphan\n') } }, { files: {} }]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files).toEqual({});
  });

  it('reads turns oldest first however they were stored', async () => {
    store('s', { k: join(work, 'a.txt') }, [
      { files: { k: entry('s', 'second\n') }, timestamp: '2026-07-02T00:00:00.000Z' },
      { files: { k: entry('s', 'first\n') }, timestamp: '2026-07-01T00:00:00.000Z' },
    ]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s').map((s) => s.timestamp)).toEqual([
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
    ]);
  });

  it('leaves the line counts at zero, because the store keeps none per file', async () => {
    store('s', { k: join(work, 'a.txt') }, [
      { files: { k: entry('s', 'one\n') } },
      { files: { k: entry('s', 'two\n') } },
    ]);
    const { readLegacyRewind } = await load();

    expect(readLegacyRewind('s')[0]?.files.k).toMatchObject({ linesAdded: 0, linesRemoved: 0 });
  });
});

describe('hashing the way this store does', () => {
  it('matches git hash-object', async () => {
    const { gitBlobHash } = await load();
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobHash(Buffer.from('hello\n'))).toBe('git-sha1:ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('hashes empty content the way git does', async () => {
    const { gitBlobHash } = await load();
    expect(gitBlobHash(Buffer.alloc(0))).toBe('git-sha1:e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});
