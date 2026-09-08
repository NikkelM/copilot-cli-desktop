import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading a session's changes back out of the CLI's rewind store.
 *
 * These build a store by hand rather than through the writer, so the reader is tested
 * against the format itself - including the shapes only the CLI produces, such as a blob it
 * has since pruned.
 */
let home: string;

async function load() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./changes.js');
}

async function keys() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./rewind.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccd-changes-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

const SESSION = 'session-1';
const dirOf = () => join(home, 'session-state', SESSION, 'rewind-file-snapshots');

/** Store a blob the way the CLI does, returning the image that points at it. */
async function blob(content: string) {
  const { contentHash } = await keys();
  const hash = contentHash(content);
  mkdirSync(join(dirOf(), 'backups'), { recursive: true });
  writeFileSync(join(dirOf(), 'backups', hash), content);
  return { kind: 'content' as const, contentHash: hash, resolvedPath: 'x', encodedPath: { encoding: 'windows-wide' as const, data: '' } };
}

/** An image whose blob was never written, standing for one the CLI has since pruned. */
async function pruned(content: string) {
  const { contentHash } = await keys();
  return {
    kind: 'content' as const,
    contentHash: contentHash(content),
    resolvedPath: 'x',
    encodedPath: { encoding: 'windows-wide' as const, data: '' },
  };
}

const ABSENT = { kind: 'absent' as const };

async function writeStore(
  snapshots: {
    at: string;
    files: { path: string; preimage: unknown; postimage: unknown; linesAdded?: number; linesRemoved?: number }[];
  }[],
) {
  const { fileKey } = await keys();
  mkdirSync(dirOf(), { recursive: true });

  const index = {
    schema: 1,
    snapshots: snapshots.map((snapshot, i) => ({
      snapshotId: `s${i}`,
      eventId: `e${i}`,
      userMessage: 'do the thing',
      timestamp: snapshot.at,
      backupFiles: [],
      fileCount: snapshot.files.length,
      linesAdded: 0,
      linesRemoved: 0,
      files: Object.fromEntries(
        snapshot.files.map((file) => [
          fileKey(file.path),
          { linesAdded: 0, linesRemoved: 0, ...file },
        ]),
      ),
    })),
  };

  writeFileSync(join(dirOf(), 'index.json'), JSON.stringify(index));
}

describe('what a session changed', () => {
  it('says nothing for a session with no snapshots', async () => {
    const { sessionChanges } = await load();
    expect(sessionChanges(SESSION)).toEqual([]);
  });

  it('reports a file the session created', async () => {
    await writeStore([{ at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/new.ts', preimage: ABSENT, postimage: await blob('one\ntwo\n') }] }]);

    const { sessionChanges } = await load();
    expect(sessionChanges(SESSION)).toEqual([
      {
        path: '/w/new.ts',
        status: 'created',
        linesAdded: 2,
        linesRemoved: 0,
        turns: 1,
        changedAt: '2026-01-01T00:00:00.000Z',
        diffable: true,
      },
    ]);
  });

  it('reports a file the session deleted', async () => {
    await writeStore([{ at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/gone.ts', preimage: await blob('one\n'), postimage: ABSENT }] }]);

    const { sessionChanges } = await load();
    expect(sessionChanges(SESSION)[0]).toMatchObject({ status: 'deleted', linesRemoved: 1, linesAdded: 0 });
  });

  /**
   * The whole point of following a file rather than reporting each turn: the before is what
   * the session found, not what the previous turn left.
   */
  it('spans every turn that touched a file', async () => {
    const start = await blob('a\n');
    const middle = await blob('b\n');
    const end = await blob('c\n');
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/f.ts', preimage: start, postimage: middle }] },
      { at: '2026-01-02T00:00:00.000Z', files: [{ path: '/w/f.ts', preimage: middle, postimage: end }] },
    ]);

    const { sessionChanges, sessionDiff } = await load();
    expect(sessionChanges(SESSION)[0]).toMatchObject({ turns: 2, changedAt: '2026-01-02T00:00:00.000Z' });
    expect(sessionDiff(SESSION, '/w/f.ts').patch).toContain('-a');
    expect(sessionDiff(SESSION, '/w/f.ts').patch).toContain('+c');
    expect(sessionDiff(SESSION, '/w/f.ts').patch).not.toContain('b');
  });

  /**
   * Per-turn counts double-count a line written and then rewritten. Two turns each adding
   * one line to the same place leaves one line added, not two.
   */
  it('counts lines over the session rather than summing turns', async () => {
    const start = await blob('a\n');
    const middle = await blob('a\nb\n');
    const end = await blob('a\nc\n');
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/f.ts', preimage: start, postimage: middle, linesAdded: 1 }] },
      { at: '2026-01-02T00:00:00.000Z', files: [{ path: '/w/f.ts', preimage: middle, postimage: end, linesAdded: 1, linesRemoved: 1 }] },
    ]);

    const { sessionChanges } = await load();
    expect(sessionChanges(SESSION)[0]).toMatchObject({ linesAdded: 1, linesRemoved: 0 });
  });

  it('leaves out a file edited back to what it was', async () => {
    const was = await blob('a\n');
    const changed = await blob('b\n');
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/f.ts', preimage: was, postimage: changed }] },
      { at: '2026-01-02T00:00:00.000Z', files: [{ path: '/w/f.ts', preimage: changed, postimage: was }] },
    ]);

    const { sessionChanges } = await load();
    expect(sessionChanges(SESSION)).toEqual([]);
  });

  it('leaves out a file created and then deleted', async () => {
    const made = await blob('a\n');
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/tmp.ts', preimage: ABSENT, postimage: made }] },
      { at: '2026-01-02T00:00:00.000Z', files: [{ path: '/w/tmp.ts', preimage: made, postimage: ABSENT }] },
    ]);

    const { sessionChanges } = await load();
    expect(sessionChanges(SESSION)).toEqual([]);
  });

  it('puts the most recently touched file first', async () => {
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/old.ts', preimage: ABSENT, postimage: await blob('a\n') }] },
      { at: '2026-01-02T00:00:00.000Z', files: [{ path: '/w/new.ts', preimage: ABSENT, postimage: await blob('b\n') }] },
    ]);

    const { sessionChanges } = await load();
    expect(sessionChanges(SESSION).map((change) => change.path)).toEqual(['/w/new.ts', '/w/old.ts']);
  });

  /** Around a quarter of the blobs a real store references are gone. That is normal. */
  it('still lists a file whose backup has been pruned, and says it has no diff', async () => {
    await writeStore([
      {
        at: '2026-01-01T00:00:00.000Z',
        files: [{ path: '/w/f.ts', preimage: await pruned('a\n'), postimage: await pruned('b\n'), linesAdded: 1, linesRemoved: 1 }],
      },
    ]);

    const { sessionChanges, sessionDiff } = await load();
    expect(sessionChanges(SESSION)[0]).toMatchObject({ diffable: false, linesAdded: 1, linesRemoved: 1 });
    expect(sessionDiff(SESSION, '/w/f.ts')).toMatchObject({ patch: null, reason: 'pruned' });
  });

  /**
   * The CLI leaves out the blob when the postimage is still what the file holds, and reads
   * the file instead. Without following it, almost nothing in a real store is diffable.
   */
  it('reads the file itself when the store left its blob out', async () => {
    const file = join(home, 'f.ts');
    writeFileSync(file, 'one\ntwo\n');
    await writeStore([{ at: '2026-01-01T00:00:00.000Z', files: [{ path: file, preimage: ABSENT, postimage: await pruned('one\ntwo\n') }] }]);

    const { sessionChanges, sessionDiff } = await load();
    expect(sessionChanges(SESSION)[0]).toMatchObject({ diffable: true, linesAdded: 2 });
    expect(sessionDiff(SESSION, file).patch).toContain('+two');
  });

  /** Only when it really is that content: a file edited since must not stand in for it. */
  it('does not pass off a file edited since as the missing blob', async () => {
    const file = join(home, 'f.ts');
    writeFileSync(file, 'someone else wrote this\n');
    await writeStore([{ at: '2026-01-01T00:00:00.000Z', files: [{ path: file, preimage: ABSENT, postimage: await pruned('one\ntwo\n') }] }]);

    const { sessionDiff } = await load();
    expect(sessionDiff(SESSION, file)).toMatchObject({ patch: null, reason: 'pruned' });
  });

  it('treats a skipped image as having no diff to show', async () => {
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/big.bin', preimage: { kind: 'skipped' }, postimage: await blob('a\n') }] },
    ]);

    const { sessionChanges } = await load();
    expect(sessionChanges(SESSION)[0]).toMatchObject({ path: '/w/big.bin', diffable: false });
  });
});

describe('the diff for one file', () => {
  it('says so when no snapshot mentions the path', async () => {
    await writeStore([]);
    const { sessionDiff } = await load();
    expect(sessionDiff(SESSION, '/w/never.ts')).toMatchObject({ patch: null, reason: 'untracked' });
  });

  it('refuses to diff binary contents', async () => {
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/f.bin', preimage: ABSENT, postimage: await blob('a\u0000b') }] },
    ]);

    const { sessionDiff } = await load();
    expect(sessionDiff(SESSION, '/w/f.bin')).toMatchObject({ patch: null, reason: 'binary' });
  });

  it('produces hunks the viewer can parse', async () => {
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: '/w/f.ts', preimage: await blob('one\ntwo\nthree\n'), postimage: await blob('one\ntwo changed\nthree\n') }] },
    ]);

    const { sessionDiff } = await load();
    const patch = sessionDiff(SESSION, '/w/f.ts').patch ?? '';
    expect(patch).toContain('@@');
    expect(patch).toContain('-two');
    expect(patch).toContain('+two changed');
  });

  /**
   * The file on disk is usually not what the session left - the user keeps working. Saying
   * so is what stops the diff being read as the current state of the file.
   */
  it('flags a file that has changed on disk since the session left it', async () => {
    const file = join(home, 'f.ts');
    writeFileSync(file, 'someone else edited this\n');
    await writeStore([{ at: '2026-01-01T00:00:00.000Z', files: [{ path: file, preimage: ABSENT, postimage: await blob('what the agent wrote\n') }] }]);

    const { sessionDiff } = await load();
    expect(sessionDiff(SESSION, file).stale).toBe(true);
  });

  it('does not flag a file still exactly as the session left it', async () => {
    const file = join(home, 'f.ts');
    writeFileSync(file, 'what the agent wrote\n');
    await writeStore([{ at: '2026-01-01T00:00:00.000Z', files: [{ path: file, preimage: ABSENT, postimage: await blob('what the agent wrote\n') }] }]);

    const { sessionDiff } = await load();
    expect(sessionDiff(SESSION, file).stale).toBe(false);
  });

  it('does not flag a file the session deleted and nobody restored', async () => {
    await writeStore([
      { at: '2026-01-01T00:00:00.000Z', files: [{ path: join(home, 'gone.ts'), preimage: await blob('a\n'), postimage: ABSENT }] },
    ]);

    const { sessionDiff } = await load();
    expect(sessionDiff(SESSION, join(home, 'gone.ts')).stale).toBe(false);
  });
});
