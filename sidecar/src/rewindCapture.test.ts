import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A turn's changes, recorded the way the CLI records them. These use real files, because
 * what is being tested is what was on disk at each end of a tool call.
 */
let home: string;
let work: string;

async function load() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return {
    ...(await import('./rewindCapture.js')),
    ...(await import('./rewind.js')),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccd-cap-home-'));
  work = mkdtempSync(join(tmpdir(), 'ccd-cap-work-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

describe('which tool calls are watched', () => {
  it.each(['create', 'edit', 'write'])('follows %s', async (tool) => {
    const { pathOf } = await load();
    expect(pathOf(tool, { path: 'C:\\a.txt' })).toBe('C:\\a.txt');
  });

  /**
   * The gap worth stating: a shell command can write anywhere and says nothing about it,
   * and shell is by far the most used tool. A turn that edits through it records nothing.
   */
  it.each(['powershell', 'bash', 'view', 'grep'])('ignores %s', async (tool) => {
    const { pathOf } = await load();
    expect(pathOf(tool, { path: 'C:\\a.txt', command: 'ls' })).toBeNull();
  });

  it('ignores a file tool that named no file', async () => {
    const { pathOf } = await load();
    expect(pathOf('edit', {})).toBeNull();
    expect(pathOf('edit', { path: '  ' })).toBeNull();
  });
});

describe('recording a turn', () => {
  it('records a file the turn created', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind, readBackup } = await load();
    const path = join(work, 'new.txt');

    const capture = beginTurn('e1', 'make a file');
    noteToolStart(capture, 'c1', path);
    writeFileSync(path, 'hello\nthere\n');
    noteToolEnd(capture, 'c1');

    expect(endTurn('s1', capture)).toBe(true);

    const [snapshot] = readRewind('s1');
    expect(snapshot?.fileCount).toBe(1);
    // Two lines, not three: the newline ending the last line does not start another.
    expect(snapshot?.linesAdded).toBe(2);

    const change = Object.values(snapshot!.files)[0]!;
    expect(change.path).toBe(path);
    expect(change.preimage.kind).toBe('absent');
    expect(change.postimage.kind).toBe('content');
    if (change.postimage.kind !== 'content') return;
    expect(readBackup('s1', change.postimage.contentHash)?.toString()).toBe('hello\nthere\n');
  });

  it('records a file the turn changed, keeping both versions', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind, readBackup } = await load();
    const path = join(work, 'a.txt');
    writeFileSync(path, 'one\ntwo\n');

    const capture = beginTurn('e1', 'change it');
    noteToolStart(capture, 'c1', path);
    writeFileSync(path, 'one\nTWO\n');
    noteToolEnd(capture, 'c1');
    endTurn('s1', capture);

    const change = Object.values(readRewind('s1')[0]!.files)[0]!;
    expect(change.preimage.kind).toBe('content');
    if (change.preimage.kind !== 'content') return;
    expect(readBackup('s1', change.preimage.contentHash)?.toString()).toBe('one\ntwo\n');
    expect(change.linesAdded).toBe(1);
    expect(change.linesRemoved).toBe(1);
  });

  it('records a file the turn deleted', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind } = await load();
    const path = join(work, 'gone.txt');
    writeFileSync(path, 'here\n');

    const capture = beginTurn('e1', 'remove it');
    noteToolStart(capture, 'c1', path);
    unlinkSync(path);
    noteToolEnd(capture, 'c1');
    endTurn('s1', capture);

    const change = Object.values(readRewind('s1')[0]!.files)[0]!;
    expect(change.preimage.kind).toBe('content');
    expect(change.postimage.kind).toBe('absent');
  });

  /**
   * A file edited twice in one turn was, before that turn, whatever it was before the first
   * edit - not what the first edit left behind. Getting this wrong would make a rewind
   * restore the middle of a turn.
   */
  it('keeps the version from before the first edit of a turn', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind, readBackup } = await load();
    const path = join(work, 'twice.txt');
    writeFileSync(path, 'original\n');

    const capture = beginTurn('e1', 'edit twice');
    noteToolStart(capture, 'c1', path);
    writeFileSync(path, 'first\n');
    noteToolEnd(capture, 'c1');

    noteToolStart(capture, 'c2', path);
    writeFileSync(path, 'second\n');
    noteToolEnd(capture, 'c2');
    endTurn('s1', capture);

    const change = Object.values(readRewind('s1')[0]!.files)[0]!;
    if (change.preimage.kind !== 'content' || change.postimage.kind !== 'content') throw new Error('expected both');
    expect(readBackup('s1', change.preimage.contentHash)?.toString()).toBe('original\n');
    expect(readBackup('s1', change.postimage.contentHash)?.toString()).toBe('second\n');
  });

  // An edit whose replacement matched what was already there changed nothing, whatever the
  // tool reported.
  it('records nothing when a tool left the file as it found it', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind } = await load();
    const path = join(work, 'same.txt');
    writeFileSync(path, 'unchanged\n');

    const capture = beginTurn('e1', 'no-op');
    noteToolStart(capture, 'c1', path);
    noteToolEnd(capture, 'c1');

    expect(endTurn('s1', capture)).toBe(false);
    expect(readRewind('s1')).toEqual([]);
  });

  it('carries the prompt that caused it, so a rewind can be named', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind } = await load();
    const path = join(work, 'x.txt');

    const capture = beginTurn('e1', 'rename the thing');
    noteToolStart(capture, 'c1', path);
    writeFileSync(path, 'x');
    noteToolEnd(capture, 'c1');
    endTurn('s1', capture);

    expect(readRewind('s1')[0]?.userMessage).toBe('rename the thing');
    expect(readRewind('s1')[0]?.eventId).toBe('e1');
  });

  it('adds a turn rather than replacing the last', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind } = await load();

    for (const [n, name] of [['1', 'a.txt'], ['2', 'b.txt']] as const) {
      const path = join(work, name);
      const capture = beginTurn(`e${n}`, `turn ${n}`);
      noteToolStart(capture, `c${n}`, path);
      writeFileSync(path, 'x');
      noteToolEnd(capture, `c${n}`);
      endTurn('s1', capture);
    }

    expect(readRewind('s1').map((s) => s.userMessage)).toEqual(['turn 1', 'turn 2']);
  });

  it('ignores a completion for a call it never saw start', async () => {
    const { beginTurn, noteToolEnd, endTurn } = await load();
    const capture = beginTurn('e1', 'stray');

    noteToolEnd(capture, 'never-started');

    expect(endTurn('s1', capture)).toBe(false);
  });

  // Someone who turned rewind off in the CLI should not have it turned back on from here.
  it('writes nothing when the CLI has tracking switched off', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind } = await load();
    const { mkdirSync } = await import('node:fs');
    const dir = join(home, 'session-state', 's1', 'rewind-file-snapshots');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tracking.json'), JSON.stringify({ schema: 1, tracking: false }));

    const path = join(work, 'a.txt');
    const capture = beginTurn('e1', 'blocked');
    noteToolStart(capture, 'c1', path);
    writeFileSync(path, 'x');
    noteToolEnd(capture, 'c1');

    expect(endTurn('s1', capture)).toBe(false);
    expect(readRewind('s1')).toEqual([]);
  });
});

describe('what the CLI will read back', () => {
  /**
   * The whole point is that the CLI can read what this wrote, so the shape is checked
   * against the rules the format was verified by rather than against this app's own types.
   */
  it('writes entries the CLI\u2019s own rules accept', async () => {
    const { beginTurn, noteToolStart, noteToolEnd, endTurn, readRewind, fileKey, encodePath } = await load();
    const path = join(work, 'shape.txt');

    const capture = beginTurn('e1', 'check the shape');
    noteToolStart(capture, 'c1', path);
    writeFileSync(path, 'content\n');
    noteToolEnd(capture, 'c1');
    endTurn('s1', capture);

    const raw = JSON.parse(
      readFileSync(join(home, 'session-state', 's1', 'rewind-file-snapshots', 'index.json'), 'utf8'),
    );
    expect(raw.schema).toBe(1);

    const snapshot = raw.snapshots[0];
    expect(Object.keys(snapshot).sort()).toEqual(
      ['backupFiles', 'eventId', 'fileCount', 'files', 'linesAdded', 'linesRemoved', 'snapshotId', 'timestamp', 'userMessage'].sort(),
    );

    for (const [key, change] of Object.entries(snapshot.files) as [string, { path: string; postimage: { kind: string; resolvedPath: string; encodedPath: unknown } }][]) {
      expect(fileKey(change.path)).toBe(key);
      if (change.postimage.kind !== 'content') continue;
      expect(encodePath(change.postimage.resolvedPath)).toEqual(change.postimage.encodedPath);
    }

    expect(readRewind('s1')[0]?.backupFiles).toHaveLength(1);
  });
});
