import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Writing into a directory the Copilot CLI owns and reads, so the format has to be exactly
 * right rather than nearly right. These point COPILOT_HOME at a throwaway directory.
 */
let home: string;

async function loadRewind() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./rewind.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccd-rewind-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

const dirOf = (session: string) => join(home, 'session-state', session, 'rewind-file-snapshots');

const snapshot = (over: Partial<import('./rewind.js').RewindSnapshot> = {}) => ({
  snapshotId: 's1',
  eventId: 'e1',
  userMessage: 'do the thing',
  timestamp: '2026-09-08T12:00:00.000Z',
  files: {},
  backupFiles: [],
  fileCount: 0,
  linesAdded: 0,
  linesRemoved: 0,
  ...over,
});

describe('the file key', () => {
  /**
   * Checked against every entry of a real store: the key is the first half of the SHA-256 of
   * the display path. Pinned here because a reader following a file through a session's
   * history has nothing else to follow it by.
   */
  it('is the first half of the sha256 of the path', async () => {
    const { fileKey } = await loadRewind();
    expect(fileKey('C:\\work\\thing.ts')).toHaveLength(32);
    expect(fileKey('C:\\work\\thing.ts')).toBe(fileKey('C:\\work\\thing.ts'));
    expect(fileKey('C:\\work\\thing.ts')).not.toBe(fileKey('C:\\work\\other.ts'));
  });

  // Taken from a real store, so a change to the derivation is caught rather than merely
  // being self-consistent.
  it('matches what the CLI itself wrote', async () => {
    const { fileKey } = await loadRewind();
    const path =
      'C:\\Users\\nikke\\.copilot\\session-state\\9ec04ce0-1361-4e11-ae34-9f8747cbac64\\files\\acp_probe.js';
    expect(fileKey(path)).toBe('74f3fa76f1cbb512f25946c8d4cd0173');
  });
});

describe('reading', () => {
  it('has nothing to say about a session it has never seen', async () => {
    const { readRewind } = await loadRewind();
    expect(readRewind('unknown')).toEqual([]);
  });

  /**
   * A schema this does not know is treated as no history rather than parsed optimistically.
   * Reading another program's file wrong is worse than not reading it.
   */
  it('refuses a schema it does not know', async () => {
    mkdirSync(dirOf('s1'), { recursive: true });
    writeFileSync(join(dirOf('s1'), 'index.json'), JSON.stringify({ schema: 99, snapshots: [snapshot()] }));

    const { readRewind } = await loadRewind();
    expect(readRewind('s1')).toEqual([]);
  });

  it('survives a file that is not json', async () => {
    mkdirSync(dirOf('s1'), { recursive: true });
    writeFileSync(join(dirOf('s1'), 'index.json'), '{ not json');

    const { readRewind } = await loadRewind();
    expect(readRewind('s1')).toEqual([]);
  });
});


describe('backups', () => {
  it('reads a blob back by its hash', async () => {
    const { contentHash, readBackup } = await loadRewind();
    const hash = contentHash('hello\n');

    mkdirSync(join(dirOf('s1'), 'backups'), { recursive: true });
    writeFileSync(join(dirOf('s1'), 'backups', hash), 'hello\n');

    expect(readBackup('s1', hash)?.toString()).toBe('hello\n');
  });

  /**
   * The CLI prunes backups while leaving the index entries that mention them - 254 of 1092
   * blobs referenced by a real store no longer existed. A missing one is history that
   * cannot be shown, not a broken store.
   */
  it('says nothing rather than failing when a backup has been pruned', async () => {
    const { readBackup } = await loadRewind();
    expect(readBackup('s1', 'a'.repeat(64))).toBeNull();
  });
});


/**
 * The real store on this machine, when there is one. Not a fixture: the point is to notice
 * if the CLI's format moves under us, which a fixture copied from it never would.
 */
describe('against the CLI\u2019s own store', () => {
  const real = join(homedir(), '.copilot', 'session-state');

  it('reads it with the same rules it is written by', async () => {
    if (!existsSync(real)) return;

    delete process.env.COPILOT_HOME;
    vi.resetModules();
    const { fileKey, contentHash } = await import('./rewind.js');
    const { readdirSync } = await import('node:fs');

    const sessions = readdirSync(real);
    const found = sessions
      .map((id) => join(real, id, 'rewind-file-snapshots', 'index.json'))
      .find((path) => existsSync(path));
    if (!found) return;

    const index = JSON.parse(readFileSync(found, 'utf8')) as { schema: number; snapshots: unknown[] };
    expect(index.schema).toBe(1);

    for (const snap of index.snapshots.slice(0, 20) as import('./rewind.js').RewindSnapshot[]) {
      for (const [key, change] of Object.entries(snap.files ?? {})) {
        expect(fileKey(change.path)).toBe(key);
        for (const image of [change.preimage, change.postimage]) {
          if (image.kind !== 'content') continue;
          expect(image.contentHash).toHaveLength(contentHash('x').length);
        }
      }
    }
  });
});
