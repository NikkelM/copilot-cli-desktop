import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store writes beside a session's own state, so the tests point that somewhere
 * disposable rather than at the reader's real sessions.
 */
let home: string;

vi.mock('./paths.js', () => ({
  sessionStateDir: (id: string) => join(process.env.CCD_TEST_HOME!, id),
}));

const { appendSnapshot, readSnapshots, writeSnapshots } = await import('./snapshotStore.js');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccd-store-'));
  process.env.CCD_TEST_HOME = home;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const record = (id: string, commit: string) => ({ id, commit, at: '2026-09-06T12:00:00.000Z' });

describe('snapshotStore', () => {
  it('has nothing to say about a session it has never seen', () => {
    expect(readSnapshots('unknown')).toBeNull();
  });

  /**
   * The point of writing these down. A session idle long enough to be evicted, or open
   * when the app was last closed, would otherwise lose every point it could be compared
   * against and report itself as having changed nothing.
   */
  it('gives the points back after the session was put down', () => {
    appendSnapshot('s1', '/repo', record('baseline', 'aaa'));
    appendSnapshot('s1', '/repo', record('turn-1', 'bbb'));

    const reopened = readSnapshots('s1');
    expect(reopened?.snapshots.map((s) => s.id)).toEqual(['baseline', 'turn-1']);
    expect(reopened?.snapshots[0]?.commit).toBe('aaa');
  });

  // The commits describe a tree the new repository knows nothing about.
  it('starts again when the session is reopened somewhere else', () => {
    appendSnapshot('s1', '/repo', record('baseline', 'aaa'));
    const moved = appendSnapshot('s1', '/elsewhere', record('baseline', 'ccc'));

    expect(moved.snapshots.map((s) => s.commit)).toEqual(['ccc']);
    expect(readSnapshots('s1')?.root).toBe('/elsewhere');
  });

  it('refuses a file it did not write', () => {
    mkdirSync(join(home, 's1'), { recursive: true });
    writeFileSync(join(home, 's1', 'desktop-snapshots.json'), '{ not json');

    expect(readSnapshots('s1')).toBeNull();
  });

  // Reading a newer format as though it were this one would misreport what happened.
  it('refuses a version it does not know', () => {
    writeSnapshots('s1', { version: 1, root: '/repo', snapshots: [record('baseline', 'aaa')] });
    const path = join(home, 's1', 'desktop-snapshots.json');
    writeFileSync(path, JSON.stringify({ version: 99, root: '/repo', snapshots: [] }));

    expect(readSnapshots('s1')).toBeNull();
  });

  it('keeps what a turn was asked to do, so a point can be named', () => {
    appendSnapshot('s1', '/repo', { ...record('turn-1', 'bbb'), prompt: 'rename the thing' });
    expect(readSnapshots('s1')?.snapshots[0]?.prompt).toBe('rename the thing');
  });
});
