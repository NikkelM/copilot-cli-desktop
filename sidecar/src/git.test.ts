import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { githubSlug, treeStateOf } from './git.js';

/**
 * Real repositories rather than a stubbed git, for the same reason the snapshot tests use
 * them: the whole of this is how git reports its own state, so a fake would test the fake.
 */
let dir: string;

const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccd-git-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  // Signing is the reader's own setting, and inheriting it makes these tests wait on a
  // GPG agent that has nothing to do with what they are testing.
  git('config', 'commit.gpgsign', 'false');
  write('tracked.txt', 'original\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('treeStateOf', () => {
  it('names the branch a clean tree is on', async () => {
    expect(await treeStateOf(dir)).toEqual({
      branch: 'main',
      detached: false,
      modified: false,
      untracked: false,
      staged: false,
      remote: null,
    });
  });

  it('answers for a directory inside the repository, not just its root', async () => {
    git('checkout', '-qb', 'feature');
    mkdirSync(join(dir, 'nested'));

    expect((await treeStateOf(join(dir, 'nested')))?.branch).toBe('feature');
  });

  it('says nothing rather than failing outside a repository', async () => {
    const loose = mkdtempSync(join(tmpdir(), 'ccd-not-git-'));
    expect(await treeStateOf(loose)).toBeNull();
    rmSync(loose, { recursive: true, force: true });
  });

  // A branch exists before its first commit does, and that is exactly when a reader is
  // most likely to be looking. Snapshots refuse this case; this must not.
  it('reports the branch of a repository with no commits', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'ccd-git-empty-'));
    execFileSync('git', ['-C', fresh, 'init', '-q', '-b', 'main']);

    expect(await treeStateOf(fresh)).toMatchObject({ branch: 'main', detached: false });
    rmSync(fresh, { recursive: true, force: true });
  });

  describe('the markers', () => {
    it('marks a tracked file that changed', async () => {
      write('tracked.txt', 'edited\n');
      expect(await treeStateOf(dir)).toMatchObject({ modified: true, untracked: false, staged: false });
    });

    it('marks a file git has never seen', async () => {
      write('new.txt', 'hello\n');
      expect(await treeStateOf(dir)).toMatchObject({ modified: false, untracked: true, staged: false });
    });

    it('marks something staged for the next commit', async () => {
      write('tracked.txt', 'edited\n');
      git('add', '-A');
      expect(await treeStateOf(dir)).toMatchObject({ modified: false, untracked: false, staged: true });
    });

    // The three are independent, and a working tree in the middle of something is usually
    // all three at once.
    it('marks staged and unstaged changes to the same file separately', async () => {
      write('tracked.txt', 'staged\n');
      git('add', '-A');
      write('tracked.txt', 'staged then edited again\n');
      write('new.txt', 'hello\n');

      expect(await treeStateOf(dir)).toMatchObject({ modified: true, untracked: true, staged: true });
    });

    it('marks a deletion as a change like any other', async () => {
      unlinkSync(join(dir, 'tracked.txt'));
      expect(await treeStateOf(dir)).toMatchObject({ modified: true });
    });
  });

  // With no branch to name, the commit is the only thing that identifies where the reader is.
  it('shows the commit when HEAD is detached', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', head);

    const state = await treeStateOf(dir);
    expect(state?.detached).toBe(true);
    expect(state?.branch).toBe(head.slice(0, 8));
  });

  /**
   * Whether a directory has a GitHub page is a question about its remotes, not about the
   * name the session store happens to have recorded - which says where it came from about
   * as reliably as a filename says what is in a file.
   */
  describe('the remote', () => {
    it('reports nothing for a repository with no remotes', async () => {
      expect((await treeStateOf(dir))?.remote).toBeNull();
    });

    it('reports the GitHub repository origin points at', async () => {
      git('remote', 'add', 'origin', 'https://github.com/NikkelM/thing.git');
      expect((await treeStateOf(dir))?.remote).toBe('NikkelM/thing');
    });

    it('reports nothing for a remote that is not on GitHub', async () => {
      git('remote', 'add', 'origin', 'https://gitlab.com/NikkelM/thing.git');
      expect((await treeStateOf(dir))?.remote).toBeNull();
    });

    // A fork usually has both, and the reader is working in origin.
    it('prefers origin over another remote', async () => {
      git('remote', 'add', 'upstream', 'https://github.com/upstream/thing.git');
      git('remote', 'add', 'origin', 'https://github.com/NikkelM/thing.git');

      expect((await treeStateOf(dir))?.remote).toBe('NikkelM/thing');
    });

    it('falls back to another remote when there is no origin', async () => {
      git('remote', 'add', 'upstream', 'git@github.com:upstream/thing.git');
      expect((await treeStateOf(dir))?.remote).toBe('upstream/thing');
    });
  });
});

describe('githubSlug', () => {
  it.each([
    ['https://github.com/NikkelM/thing.git', 'NikkelM/thing'],
    ['https://github.com/NikkelM/thing', 'NikkelM/thing'],
    ['http://github.com/NikkelM/thing/', 'NikkelM/thing'],
    ['git@github.com:NikkelM/thing.git', 'NikkelM/thing'],
    ['ssh://git@github.com/NikkelM/thing.git', 'NikkelM/thing'],
    ['https://user:token@github.com/NikkelM/thing.git', 'NikkelM/thing'],
    // Case is not meaningful in a host name, and git does not normalise it.
    ['https://GitHub.com/NikkelM/thing', 'NikkelM/thing'],
  ])('reads %s as %s', (url, expected) => {
    expect(githubSlug(url)).toBe(expected);
  });

  it.each([
    ['https://gitlab.com/NikkelM/thing.git'],
    ['git@bitbucket.org:NikkelM/thing.git'],
    ['C:\\work\\some-bare-repo'],
    // Close enough to catch a substring match written carelessly, but not GitHub.
    ['https://github.com.evil.example/NikkelM/thing'],
    ['https://notgithub.com/NikkelM/thing'],
    [''],
  ])('reports nothing for %s', (url) => {
    expect(githubSlug(url)).toBeNull();
  });
});
