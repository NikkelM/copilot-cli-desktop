import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { githubSlug, stagePath, statusOf, treeStateOf, unstagePath } from './git.js';

/**
 * Every test here spawns git, several times over.
 *
 * The default five seconds is a limit on how long a piece of pure logic may take, and these
 * are not that: one of them was measured at 3.2s alone, which leaves nothing for a machine
 * that is also running the app. A generous limit here still catches a genuine hang, and
 * stops a busy machine from being reported as a broken test.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Real repositories rather than a stubbed git: the whole of this is how git reports its own
 * state, so a fake would test the fake.
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
  // most likely to be looking

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

/**
 * The whole state of a working tree, which is what a source control panel draws (#42).
 *
 * Real repositories again: every shape below was first produced by running git and reading
 * what it printed, because the porcelain format's field counts differ per entry kind and
 * guessing them is how a parser ends up returning paths with their metadata attached.
 */
describe('statusOf', () => {
  it('names the branch and counts nothing on a clean tree', async () => {
    const found = await statusOf(dir);

    expect(found).toEqual({ branch: 'main', detached: false, ahead: 0, behind: 0, files: [] });
  });

  it('says nothing about a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ccd-not-git-'));

    expect(await statusOf(plain)).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });

  it('reports a file the working tree has changed', async () => {
    write('tracked.txt', 'changed\n');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', unstaged: 'modified' }]);
  });

  it('reports a file waiting in the index', async () => {
    write('tracked.txt', 'changed\n');
    git('add', 'tracked.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', staged: 'modified' }]);
  });

  /** A reader needs this as one row, not as two files that happen to share a name. */
  it('reports a file staged and then changed again as one row', async () => {
    write('tracked.txt', 'staged\n');
    git('add', 'tracked.txt');
    write('tracked.txt', 'and changed since\n');

    expect((await statusOf(dir))?.files).toEqual([
      { path: 'tracked.txt', staged: 'modified', unstaged: 'modified' },
    ]);
  });

  it('reports a new file as untracked', async () => {
    write('new.txt', 'hello\n');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'new.txt', unstaged: 'untracked' }]);
  });

  it('reports a deleted file', async () => {
    unlinkSync(join(dir, 'tracked.txt'));

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', unstaged: 'deleted' }]);
  });

  it('reports a staged addition', async () => {
    write('new.txt', 'hello\n');
    git('add', 'new.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'new.txt', staged: 'added' }]);
  });

  /** Where a rename came from is half of what the row means. */
  it('reports a rename and what it was called before', async () => {
    git('mv', 'tracked.txt', 'renamed.txt');

    expect((await statusOf(dir))?.files).toEqual([
      { path: 'renamed.txt', staged: 'renamed', from: 'tracked.txt' },
    ]);
  });

  // The path is the last field, and a rename puts a score before it. Splitting the line on
  // spaces instead would cut a name like this in half.
  it('keeps a path that has a space in it', async () => {
    write('with space.txt', 'hello\n');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'with space.txt', unstaged: 'untracked' }]);
  });

  it('reads the branch it tracks and how far apart they are', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'ccd-git-remote-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8' });
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'main');
    write('tracked.txt', 'ahead by one\n');
    git('commit', '-qam', 'ahead');

    const found = await statusOf(dir);
    expect(found?.upstream).toBe('origin/main');
    expect(found?.ahead).toBe(1);
    expect(found?.behind).toBe(0);
    rmSync(remote, { recursive: true, force: true });
  });

  it('shows the commit when there is no branch to name', async () => {
    git('checkout', '-q', '--detach');

    const found = await statusOf(dir);
    expect(found?.detached).toBe(true);
    expect(found?.branch).toHaveLength(8);
  });

  /** A repository whose first commit is still to come has a branch and no HEAD. */
  it('still names the branch before the first commit', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'ccd-git-fresh-'));
    execFileSync('git', ['-C', fresh, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
    writeFileSync(join(fresh, 'first.txt'), 'hello\n');

    const found = await statusOf(fresh);
    expect(found?.branch).toBe('main');
    expect(found?.files).toEqual([{ path: 'first.txt', unstaged: 'untracked' }]);
    rmSync(fresh, { recursive: true, force: true });
  });

  // Git lists in index-walk order, which puts a file wherever the tree happens to hold it.
  it('lists in a stable order', async () => {
    write('b.txt', 'b\n');
    write('a.txt', 'a\n');
    write('c.txt', 'c\n');

    expect((await statusOf(dir))?.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('leaves ignored files out entirely', async () => {
    write('.gitignore', 'ignored.txt\n');
    write('ignored.txt', 'hello\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'ignore');

    expect((await statusOf(dir))?.files).toEqual([]);
  });
});


/**
 * Staging and unstaging, the first operations here that change anything (#43).
 *
 * The rule this epic is built on is that nothing may destroy uncommitted work. Every test
 * below therefore checks the working tree as well as the index - an unstage that quietly
 * rewrote a file would otherwise pass every assertion about git's status and still be the
 * worst bug this app could have.
 */
describe('staging a path', () => {
  it('puts a working tree change into the index', async () => {
    write('tracked.txt', 'changed\n');

    await stagePath(dir, 'tracked.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', staged: 'modified' }]);
  });

  it('puts a new file into the index', async () => {
    write('new.txt', 'hello\n');

    await stagePath(dir, 'new.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'new.txt', staged: 'added' }]);
  });

  /** Clicking a `D` row is asking for the removal to be part of the commit. */
  it('records a deletion', async () => {
    unlinkSync(join(dir, 'tracked.txt'));

    await stagePath(dir, 'tracked.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', staged: 'deleted' }]);
  });

  it('leaves every other path alone', async () => {
    write('one.txt', 'one\n');
    write('two.txt', 'two\n');

    await stagePath(dir, 'one.txt');

    const files = (await statusOf(dir))?.files ?? [];
    expect(files.find((file) => file.path === 'two.txt')).toEqual({ path: 'two.txt', unstaged: 'untracked' });
  });
});

describe('unstaging a path', () => {
  it('takes a staged change back out', async () => {
    write('tracked.txt', 'changed\n');
    git('add', 'tracked.txt');

    await unstagePath(dir, 'tracked.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', unstaged: 'modified' }]);
  });

  /** The file stays on disk, which is what makes it untracked rather than gone. */
  it('returns a newly added file to being untracked', async () => {
    write('new.txt', 'hello\n');
    git('add', 'new.txt');

    await unstagePath(dir, 'new.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'new.txt', unstaged: 'untracked' }]);
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('hello\n');
  });

  /**
   * The case a careless implementation gets wrong: the index holds one version, the working
   * tree another, and unstaging must return the first without disturbing the second.
   */
  it('keeps the working tree version of a file staged and then edited again', async () => {
    write('tracked.txt', 'staged version\n');
    git('add', 'tracked.txt');
    write('tracked.txt', 'working version\n');

    await unstagePath(dir, 'tracked.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', unstaged: 'modified' }]);
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('working version\n');
  });

  /**
   * A staged deletion has no index entry to update, only one to put back - and putting it
   * back must not bring the file with it. Unstaging is about the index; the working tree is
   * the reader's.
   */
  it('takes back a staged deletion without resurrecting the file', async () => {
    unlinkSync(join(dir, 'tracked.txt'));
    git('add', 'tracked.txt');

    await unstagePath(dir, 'tracked.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', unstaged: 'deleted' }]);
    expect(existsSync(join(dir, 'tracked.txt'))).toBe(false);
  });

  it('leaves other staged work staged', async () => {
    write('one.txt', 'one\n');
    write('two.txt', 'two\n');
    git('add', '-A');

    await unstagePath(dir, 'one.txt');

    const files = (await statusOf(dir))?.files ?? [];
    expect(files.find((file) => file.path === 'two.txt')).toEqual({ path: 'two.txt', staged: 'added' });
  });

  /** A repository whose first commit is still to come has no HEAD to read an entry from. */
  it('unstages in a repository with no commits yet', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'ccd-git-fresh-'));
    execFileSync('git', ['-C', fresh, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
    writeFileSync(join(fresh, 'first.txt'), 'hello\n');
    execFileSync('git', ['-C', fresh, 'add', 'first.txt'], { encoding: 'utf8' });

    await unstagePath(fresh, 'first.txt');

    expect((await statusOf(fresh))?.files).toEqual([{ path: 'first.txt', unstaged: 'untracked' }]);
    expect(readFileSync(join(fresh, 'first.txt'), 'utf8')).toBe('hello\n');
    rmSync(fresh, { recursive: true, force: true });
  });

  it('handles a path with a space in it', async () => {
    write('with space.txt', 'hello\n');
    git('add', 'with space.txt');

    await unstagePath(dir, 'with space.txt');

    expect((await statusOf(dir))?.files).toEqual([{ path: 'with space.txt', unstaged: 'untracked' }]);
  });
});

