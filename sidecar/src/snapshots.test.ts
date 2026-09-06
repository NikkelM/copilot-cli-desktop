import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changesSince, diffOf, restoreTo, takeSnapshot, workspaceOf, type Workspace } from './snapshots.js';

/**
 * Real repositories rather than a stubbed git. The whole mechanism is what git does with
 * an unreferenced commit, so a fake would only be testing the fake.
 */
let dir: string;
let index: string;

const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccd-snap-test-'));
  index = join(dir, '.git', 'desktop-index');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  // Signing is the reader's own setting, and inheriting it makes these tests wait on a
  // GPG agent that has nothing to do with what they are testing.
  git('config', 'commit.gpgsign', 'false');
  // Line endings are git's business, not this module's; converting them here would make
  // the tests about the machine they run on.
  git('config', 'core.autocrlf', 'false');
  write('tracked.txt', 'original\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function workspace(): Promise<Workspace> {
  const found = await workspaceOf(dir);
  if (!found) throw new Error('expected a workspace');
  return found;
}

describe('workspaceOf', () => {
  it('finds the repository a directory belongs to', async () => {
    mkdirSync(join(dir, 'nested'));
    const found = await workspaceOf(join(dir, 'nested'));
    expect(found?.root.replace(/\//g, '\\').toLowerCase()).toContain('ccd-snap-test');
  });

  it('refuses a directory that is not in a repository', async () => {
    const loose = mkdtempSync(join(tmpdir(), 'ccd-not-git-'));
    expect(await workspaceOf(loose)).toBeNull();
    rmSync(loose, { recursive: true, force: true });
  });

  // Nothing to diff against, which is why the CLI's own snapshots refuse this case too.
  it('refuses a repository with no commits', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'ccd-empty-git-'));
    execFileSync('git', ['-C', fresh, 'init', '-q']);
    expect(await workspaceOf(fresh)).toBeNull();
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe('changesSince', () => {
  it('reports a file the agent changed', async () => {
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    write('tracked.txt', 'changed by the agent\n');

    expect(await changesSince(ws, snapshot!, index)).toEqual([{ path: 'tracked.txt', status: 'modified' }]);
  });

  it('reports a file the agent created', async () => {
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    write('new.txt', 'made by the agent\n');

    expect(await changesSince(ws, snapshot!, index)).toEqual([{ path: 'new.txt', status: 'added' }]);
  });

  it('reports a file the agent deleted', async () => {
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    unlinkSync(join(dir, 'tracked.txt'));

    expect(await changesSince(ws, snapshot!, index)).toEqual([{ path: 'tracked.txt', status: 'deleted' }]);
  });

  /**
   * The reason this exists. A session's diff should be the agent's work, not whatever was
   * half-finished when it started - and the snapshot holds that, so it cancels out.
   */
  it('leaves out work that was already in progress', async () => {
    write('tracked.txt', 'edited by the reader before the turn\n');
    write('mine.txt', 'left lying about\n');

    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');

    expect(await changesSince(ws, snapshot!, index)).toEqual([]);
  });

  it('separates the agent\u2019s edit from one already in progress on the same file', async () => {
    write('tracked.txt', 'reader was here\n');
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    write('tracked.txt', 'reader was here\nand then the agent\n');

    const changes = await changesSince(ws, snapshot!, index);
    expect(changes).toEqual([{ path: 'tracked.txt', status: 'modified' }]);

    const patch = await diffOf(ws, snapshot!, 'tracked.txt', index);
    expect(patch).toContain('and then the agent');
    // The reader's line is in the snapshot, so it is context rather than an addition.
    expect(patch).not.toContain('+reader was here');
  });

  it('says nothing changed when nothing did', async () => {
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    expect(await changesSince(ws, snapshot!, index)).toEqual([]);
  });

  // The commit stash create writes is unreferenced, and would be collected out from under
  // the session it belongs to.
  it('keeps the snapshot alive against collection', async () => {
    const ws = await workspace();
    write('tracked.txt', 'dirty before\n');
    const snapshot = await takeSnapshot(ws, index, 'session-a');

    execFileSync('git', ['-C', dir, 'gc', '--prune=now', '--quiet']);

    write('tracked.txt', 'dirty before\nand the agent\n');
    expect(await changesSince(ws, snapshot!, index)).toEqual([{ path: 'tracked.txt', status: 'modified' }]);
  });

  it('leaves the working tree exactly as it found it', async () => {
    write('tracked.txt', 'uncommitted work\n');
    write('untracked.txt', 'also mine\n');
    const before = git('status', '--porcelain');

    const ws = await workspace();
    await takeSnapshot(ws, index, 's1');

    expect(git('status', '--porcelain')).toBe(before);
    expect(git('stash', 'list')).toBe('');
  });
});

describe('restoreTo', () => {
  it('puts back a file the agent changed', async () => {
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    write('tracked.txt', 'the agent rewrote this\n');

    const undone = await restoreTo(ws, snapshot!, index);

    expect(undone).toEqual([{ path: 'tracked.txt', status: 'modified' }]);
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('removes a file the agent created', async () => {
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    write('invented.txt', 'made up\n');

    await restoreTo(ws, snapshot!, index);

    expect(existsSync(join(dir, 'invented.txt'))).toBe(false);
  });

  it('brings back a file the agent deleted', async () => {
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    unlinkSync(join(dir, 'tracked.txt'));

    await restoreTo(ws, snapshot!, index);

    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  /**
   * The one that decides whether this is safe to offer. A rewind that also undid the
   * reader's own work would take away something the app never recorded and cannot give
   * back, so anything inside the snapshot has to survive it untouched.
   */
  it('leaves work that predates the snapshot alone', async () => {
    write('tracked.txt', 'the reader was here\n');
    write('mine.txt', 'not the agent\u2019s\n');

    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    write('agent.txt', 'the agent\u2019s\n');

    await restoreTo(ws, snapshot!, index);

    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('the reader was here\n');
    expect(readFileSync(join(dir, 'mine.txt'), 'utf8')).toBe('not the agent\u2019s\n');
    expect(existsSync(join(dir, 'agent.txt'))).toBe(false);
  });

  // Files git never tracked are captured too, which is what the private index buys.
  it('restores a file git was not tracking', async () => {
    write('scratch.txt', 'before\n');
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    write('scratch.txt', 'after\n');

    await restoreTo(ws, snapshot!, index);

    expect(readFileSync(join(dir, 'scratch.txt'), 'utf8')).toBe('before\n');
  });

  it('does not touch the staging area the reader set up', async () => {
    write('tracked.txt', 'staged by the reader\n');
    git('add', 'tracked.txt');
    const staged = git('diff', '--cached', '--name-only');

    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    write('other.txt', 'agent work\n');
    await restoreTo(ws, snapshot!, index);

    expect(git('diff', '--cached', '--name-only')).toBe(staged);
  });

  it('says nothing was undone when nothing had changed', async () => {
    const ws = await workspace();
    const snapshot = await takeSnapshot(ws, index, 's1');
    expect(await restoreTo(ws, snapshot!, index)).toEqual([]);
  });
});
