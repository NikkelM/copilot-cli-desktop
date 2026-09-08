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

describe('the encoded path', () => {
  // Big-endian, which is not what the little-endian Windows convention suggests: 1092 of
  // 1092 entries in a real store match big-endian and none match little-endian.
  it('is utf-16 big-endian hex', async () => {
    const { encodePath } = await loadRewind();
    expect(encodePath('C:')).toEqual({ encoding: 'windows-wide', data: '0043003a' });
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

describe('writing', () => {
  it('records a turn and reads it back', async () => {
    const { appendRewind, readRewind } = await loadRewind();

    expect(appendRewind('s1', snapshot({ userMessage: 'first' }))).toBe(true);
    appendRewind('s1', snapshot({ snapshotId: 's2', userMessage: 'second' }));

    expect(readRewind('s1').map((s) => s.userMessage)).toEqual(['first', 'second']);
  });

  it('writes the schema the CLI expects', async () => {
    const { appendRewind } = await loadRewind();
    appendRewind('s1', snapshot());

    const written = JSON.parse(readFileSync(join(dirOf('s1'), 'index.json'), 'utf8'));
    expect(written.schema).toBe(1);
  });

  // Left behind, the staging file would be read by nothing but would look like debris in a
  // directory another program owns.
  it('leaves no staging file behind', async () => {
    const { appendRewind } = await loadRewind();
    appendRewind('s1', snapshot());

    expect(existsSync(join(dirOf('s1'), 'index.json.tmp'))).toBe(false);
  });

  it('starts tracking a session nothing has tracked yet', async () => {
    const { appendRewind } = await loadRewind();
    appendRewind('s1', snapshot());

    const tracking = JSON.parse(readFileSync(join(dirOf('s1'), 'tracking.json'), 'utf8'));
    expect(tracking).toEqual({ schema: 1, tracking: true });
  });

  /**
   * Someone who turned rewind off in the CLI should not have it turned back on by another
   * program writing to the same directory.
   */
  it('writes nothing when the CLI has tracking switched off', async () => {
    mkdirSync(dirOf('s1'), { recursive: true });
    writeFileSync(join(dirOf('s1'), 'tracking.json'), JSON.stringify({ schema: 1, tracking: false }));

    const { appendRewind, readRewind } = await loadRewind();
    expect(appendRewind('s1', snapshot())).toBe(false);
    expect(readRewind('s1')).toEqual([]);
  });

  it('does not overwrite the CLI\u2019s own tracking file', async () => {
    mkdirSync(dirOf('s1'), { recursive: true });
    writeFileSync(join(dirOf('s1'), 'tracking.json'), JSON.stringify({ schema: 1, tracking: true, extra: 'kept' }));

    const { appendRewind } = await loadRewind();
    appendRewind('s1', snapshot());

    const tracking = JSON.parse(readFileSync(join(dirOf('s1'), 'tracking.json'), 'utf8'));
    expect(tracking.extra).toBe('kept');
  });
});

describe('backups', () => {
  it('stores contents under their own hash and reads them back', async () => {
    const { imageOf, readBackup } = await loadRewind();
    const image = imageOf('s1', 'C:\\work\\a.txt', Buffer.from('hello\n'));

    expect(image.kind).toBe('content');
    if (image.kind !== 'content') return;
    expect(readBackup('s1', image.contentHash)?.toString()).toBe('hello\n');
  });

  it('stores identical contents once', async () => {
    const { imageOf, backupCount } = await loadRewind();
    imageOf('s1', 'C:\\work\\a.txt', Buffer.from('same'));
    imageOf('s1', 'C:\\work\\b.txt', Buffer.from('same'));

    expect(backupCount('s1')).toBe(1);
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

describe('counting lines', () => {
  it('counts a new file as all added', async () => {
    const { countLines } = await loadRewind();
    expect(countLines(null, Buffer.from('a\nb\nc'))).toEqual({ linesAdded: 3, linesRemoved: 0 });
  });

  it('counts a deleted file as all removed', async () => {
    const { countLines } = await loadRewind();
    expect(countLines(Buffer.from('a\nb'), null)).toEqual({ linesAdded: 0, linesRemoved: 2 });
  });

  // Without excluding the shared ends, editing one line of a long file would read as the
  // whole file being rewritten.
  it('ignores what did not change around an edit', async () => {
    const { countLines } = await loadRewind();
    const before = Buffer.from('one\ntwo\nthree\nfour');
    const after = Buffer.from('one\nTWO\nthree\nfour');

    expect(countLines(before, after)).toEqual({ linesAdded: 1, linesRemoved: 1 });
  });

  it('says nothing changed when nothing did', async () => {
    const { countLines } = await loadRewind();
    const same = Buffer.from('a\nb\nc');
    expect(countLines(same, same)).toEqual({ linesAdded: 0, linesRemoved: 0 });
  });
});

describe('the summary the CLI keeps on each snapshot', () => {
  it('totals the files and lines, and lists every blob referenced', async () => {
    const { summarise, imageOf } = await loadRewind();
    const before = imageOf('s1', 'C:\\a.txt', Buffer.from('old'));
    const after = imageOf('s1', 'C:\\a.txt', Buffer.from('new'));

    const summary = summarise({
      k1: { path: 'C:\\a.txt', preimage: before, postimage: after, linesAdded: 1, linesRemoved: 1 },
      k2: { path: 'C:\\b.txt', preimage: { kind: 'absent' }, postimage: after, linesAdded: 3, linesRemoved: 0 },
    });

    expect(summary.fileCount).toBe(2);
    expect(summary.linesAdded).toBe(4);
    expect(summary.linesRemoved).toBe(1);
    expect(summary.backupFiles).toHaveLength(2);
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
    const { fileKey, encodePath, contentHash } = await import('./rewind.js');
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
          expect(encodePath(image.resolvedPath)).toEqual(image.encodedPath);
          expect(image.contentHash).toHaveLength(contentHash('x').length);
        }
      }
    }
  });
});
