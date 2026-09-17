import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  commitStaged,
  explainGit,
  githubSlug,
  inRuns,
  pullBranch,
  pushBranch,
  stagePaths,
  statusOf,
  treeStateOf,
  unstagePaths,
} from './git.js';
import { canAmend } from '../../shared/protocol.js';
import type { RepoStatus } from '../../shared/protocol.js';

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

    await stagePaths(dir, ['tracked.txt']);

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', staged: 'modified' }]);
  });

  it('puts a new file into the index', async () => {
    write('new.txt', 'hello\n');

    await stagePaths(dir, ['new.txt']);

    expect((await statusOf(dir))?.files).toEqual([{ path: 'new.txt', staged: 'added' }]);
  });

  /** Clicking a `D` row is asking for the removal to be part of the commit. */
  it('records a deletion', async () => {
    unlinkSync(join(dir, 'tracked.txt'));

    await stagePaths(dir, ['tracked.txt']);

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', staged: 'deleted' }]);
  });

  it('leaves every other path alone', async () => {
    write('one.txt', 'one\n');
    write('two.txt', 'two\n');

    await stagePaths(dir, ['one.txt']);

    const files = (await statusOf(dir))?.files ?? [];
    expect(files.find((file) => file.path === 'two.txt')).toEqual({ path: 'two.txt', unstaged: 'untracked' });
  });
});

describe('unstaging a path', () => {
  it('takes a staged change back out', async () => {
    write('tracked.txt', 'changed\n');
    git('add', 'tracked.txt');

    await unstagePaths(dir, ['tracked.txt']);

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', unstaged: 'modified' }]);
  });

  /** The file stays on disk, which is what makes it untracked rather than gone. */
  it('returns a newly added file to being untracked', async () => {
    write('new.txt', 'hello\n');
    git('add', 'new.txt');

    await unstagePaths(dir, ['new.txt']);

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

    await unstagePaths(dir, ['tracked.txt']);

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

    await unstagePaths(dir, ['tracked.txt']);

    expect((await statusOf(dir))?.files).toEqual([{ path: 'tracked.txt', unstaged: 'deleted' }]);
    expect(existsSync(join(dir, 'tracked.txt'))).toBe(false);
  });

  it('leaves other staged work staged', async () => {
    write('one.txt', 'one\n');
    write('two.txt', 'two\n');
    git('add', '-A');

    await unstagePaths(dir, ['one.txt']);

    const files = (await statusOf(dir))?.files ?? [];
    expect(files.find((file) => file.path === 'two.txt')).toEqual({ path: 'two.txt', staged: 'added' });
  });

  /** A repository whose first commit is still to come has no HEAD to read an entry from. */
  it('unstages in a repository with no commits yet', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'ccd-git-fresh-'));
    execFileSync('git', ['-C', fresh, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
    writeFileSync(join(fresh, 'first.txt'), 'hello\n');
    execFileSync('git', ['-C', fresh, 'add', 'first.txt'], { encoding: 'utf8' });

    await unstagePaths(fresh, ['first.txt']);

    expect((await statusOf(fresh))?.files).toEqual([{ path: 'first.txt', unstaged: 'untracked' }]);
    expect(readFileSync(join(fresh, 'first.txt'), 'utf8')).toBe('hello\n');
    rmSync(fresh, { recursive: true, force: true });
  });

  it('handles a path with a space in it', async () => {
    write('with space.txt', 'hello\n');
    git('add', 'with space.txt');

    await unstagePaths(dir, ['with space.txt']);

    expect((await statusOf(dir))?.files).toEqual([{ path: 'with space.txt', unstaged: 'untracked' }]);
  });
});


/**
 * Committing (#44). Messages are the reader's own - nothing here writes one - and the one
 * irreversible thing on offer, amending published history, is refused rather than warned
 * about.
 */
describe('committing what is staged', () => {
  const log = () => git('log', '--oneline').trim().split('\n');

  it('records the staged work under the message it was given', async () => {
    write('tracked.txt', 'changed\n');
    git('add', 'tracked.txt');

    await commitStaged(dir, 'A message of my own', false);

    expect(log()[0]).toContain('A message of my own');
    expect((await statusOf(dir))?.files).toEqual([]);
  });

  /** Half the point of staging is deciding what goes in, so the rest must stay out. */
  it('leaves unstaged work where it is', async () => {
    write('staged.txt', 'in\n');
    write('unstaged.txt', 'out\n');
    git('add', 'staged.txt');

    await commitStaged(dir, 'Only the staged one', false);

    expect((await statusOf(dir))?.files).toEqual([{ path: 'unstaged.txt', unstaged: 'untracked' }]);
  });

  it('keeps every line of a multi-line message', async () => {
    write('tracked.txt', 'changed\n');
    git('add', 'tracked.txt');

    await commitStaged(dir, 'A subject\n\nAnd a body explaining it.', false);

    expect(git('log', '-1', '--format=%B')).toContain('And a body explaining it.');
  });

  it('refuses a message that says nothing', async () => {
    write('tracked.txt', 'changed\n');
    git('add', 'tracked.txt');

    await expect(commitStaged(dir, '   \n  ', false)).rejects.toThrow('needs a message');
    expect(log()).toHaveLength(1);
  });

  /** Git's own error for this says less, and the reader has a panel that could have told them. */
  it('says so when nothing is staged', async () => {
    write('tracked.txt', 'changed\n');

    await expect(commitStaged(dir, 'Nothing to say', false)).rejects.toThrow('Nothing is staged');
  });
});

describe('amending the last commit', () => {
  it('replaces the message without making a second commit', async () => {
    const before = git('log', '--oneline').trim().split('\n').length;

    await commitStaged(dir, 'Said better', true);

    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(before);
    expect(git('log', '-1', '--format=%s').trim()).toBe('Said better');
  });

  /** Rewording the last commit with nothing staged is a real thing to want. */
  it('amends with nothing staged', async () => {
    await expect(commitStaged(dir, 'Just the wording', true)).resolves.toBeUndefined();
  });

  it('folds staged work into the commit that is there', async () => {
    write('extra.txt', 'forgot this\n');
    git('add', 'extra.txt');

    await commitStaged(dir, 'base, with the bit I forgot', true);

    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1);
    expect(git('show', '--name-only', '--format=', 'HEAD')).toContain('extra.txt');
  });

  /**
   * The one irreversible thing this panel could do. A published commit belongs to everyone
   * who has fetched it, and rewriting it is not something to warn about and then allow.
   */
  it('refuses to amend a commit that has been pushed', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'ccd-git-remote-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8' });
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'main');

    await expect(commitStaged(dir, 'Rewriting history', true)).rejects.toThrow('already been pushed');
    expect(git('log', '-1', '--format=%s').trim()).toBe('base');
    rmSync(remote, { recursive: true, force: true });
  });

  it('allows amending a commit that is not pushed yet', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'ccd-git-remote-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8' });
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'main');
    write('tracked.txt', 'more\n');
    git('commit', '-qam', 'not pushed yet');

    await expect(commitStaged(dir, 'reworded', true)).resolves.toBeUndefined();
    expect(git('log', '-1', '--format=%s').trim()).toBe('reworded');
    rmSync(remote, { recursive: true, force: true });
  });
});

describe('whether the last commit may be amended', () => {
  const at = (over: Partial<RepoStatus>): RepoStatus => ({
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    files: [],
    ...over,
  });

  it('allows it when the branch tracks nothing', () => {
    expect(canAmend(at({}))).toBe(true);
  });

  it('allows it when the branch is ahead of what it tracks', () => {
    expect(canAmend(at({ upstream: 'origin/main', ahead: 1 }))).toBe(true);
  });

  it('refuses when the branch is level with what it tracks', () => {
    expect(canAmend(at({ upstream: 'origin/main', ahead: 0 }))).toBe(false);
  });

  it('refuses when there is nothing to amend', () => {
    expect(canAmend(null)).toBe(false);
  });
});




describe('staging and unstaging many paths at once', () => {
  it('stages every path it is given', async () => {
    write('a.txt', 'a\n');
    write('b.txt', 'b\n');
    write('c.txt', 'c\n');

    await stagePaths(dir, ['a.txt', 'b.txt', 'c.txt']);

    const status = await statusOf(dir);
    expect(status?.files.map((file) => file.path).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(status?.files.every((file) => file.staged)).toBe(true);
  });

  it('leaves a path it was not given alone', async () => {
    write('a.txt', 'a\n');
    write('untouched.txt', 'u\n');

    await stagePaths(dir, ['a.txt']);

    const status = await statusOf(dir);
    expect(status?.files.find((file) => file.path === 'untouched.txt')?.staged).toBeUndefined();
  });

  it('unstages every path it is given', async () => {
    write('a.txt', 'a\n');
    write('b.txt', 'b\n');
    await stagePaths(dir, ['a.txt', 'b.txt']);

    await unstagePaths(dir, ['a.txt', 'b.txt']);

    const status = await statusOf(dir);
    expect(status?.files.every((file) => file.staged === undefined)).toBe(true);
  });

  it('leaves the working tree alone when it unstages many', async () => {
    write('tracked.txt', 'changed\n');
    await stagePaths(dir, ['tracked.txt']);

    await unstagePaths(dir, ['tracked.txt']);

    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('changed\n');
  });

  it('unstages many before the first commit, where there is no HEAD to restore from', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ccd-git-empty-'));
    try {
      execFileSync('git', ['-C', empty, 'init', '-q', '-b', 'main']);
      writeFileSync(join(empty, 'a.txt'), 'a\n');
      writeFileSync(join(empty, 'b.txt'), 'b\n');
      await stagePaths(empty, ['a.txt', 'b.txt']);

      await unstagePaths(empty, ['a.txt', 'b.txt']);

      const status = await statusOf(empty);
      expect(status?.files.every((file) => file.staged === undefined)).toBe(true);
      expect(readFileSync(join(empty, 'a.txt'), 'utf8')).toBe('a\n');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does nothing at all when given nothing', async () => {
    write('a.txt', 'a\n');

    await stagePaths(dir, []);

    const status = await statusOf(dir);
    expect(status?.files.find((file) => file.path === 'a.txt')?.staged).toBeUndefined();
  });

  /**
   * Nine hundred of these names is about 46k characters, and node refuses to spawn a command
   * over roughly 32k with `ENAMETOOLONG`. Measured rather than assumed: six hundred was tried
   * first and squeaked under the limit, which made the test pass whether or not the paths
   * were ever split.
   */
  const manyNames = () =>
    Array.from({ length: 900 }, (_, at) => `${'file-with-a-long-name'.repeat(2)}-${at}.txt`);

  it('stages more paths than one command line could hold', async () => {
    const names = manyNames();
    for (const name of names) write(name, 'x\n');

    await stagePaths(dir, names);

    const status = await statusOf(dir);
    expect(status?.files.filter((file) => file.staged)).toHaveLength(names.length);
  });

  it('unstages more paths than one command line could hold', async () => {
    const names = manyNames();
    for (const name of names) write(name, 'x\n');
    await stagePaths(dir, names);

    await unstagePaths(dir, names);

    const status = await statusOf(dir);
    expect(status?.files.filter((file) => file.staged)).toHaveLength(0);
  });
});

describe('splitting paths into runs short enough to spawn', () => {
  it('keeps a short list in one run', () => {
    expect(inRuns(['a.txt', 'b.txt', 'c.txt'])).toEqual([['a.txt', 'b.txt', 'c.txt']]);
  });

  it('gives nothing back for nothing', () => {
    expect(inRuns([])).toEqual([]);
  });

  it('splits a list too long for one command', () => {
    const names = Array.from({ length: 900 }, (_, at) => `${'x'.repeat(40)}-${at}.txt`);

    expect(inRuns(names).length).toBeGreaterThan(1);
  });

  it('keeps every path when it splits', () => {
    const names = Array.from({ length: 900 }, (_, at) => `${'x'.repeat(40)}-${at}.txt`);

    expect(inRuns(names).flat()).toEqual(names);
  });

  it('keeps every run under what a command line can take', () => {
    const names = Array.from({ length: 900 }, (_, at) => `${'x'.repeat(40)}-${at}.txt`);

    for (const run of inRuns(names)) {
      expect(run.join(' ').length).toBeLessThan(32_000);
    }
  });

  it('carries a single path longer than the limit rather than dropping it', () => {
    const huge = 'x'.repeat(20_000);

    expect(inRuns([huge])).toEqual([[huge]]);
  });

  it('gives an over-long path a run of its own', () => {
    const huge = 'x'.repeat(20_000);

    expect(inRuns(['a.txt', huge])).toEqual([['a.txt'], [huge]]);
  });
});


/**
 * A real bare repository as the remote, cloned twice: pushing and pulling are about two
 * checkouts disagreeing, and a stub cannot disagree with anything.
 */
describe('pushing and pulling', () => {
  let remote: string;
  let here: string;
  let elsewhere: string;

  const at = (where: string, ...args: string[]) =>
    execFileSync('git', ['-C', where, ...args], { encoding: 'utf8' });

  // A bare repository cannot be read with -C when safe.bareRepository is xplicit,
  // which is a real setting real people have.
  const inRemote = (...args: string[]) =>
    execFileSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' });

  const settle = (where: string) => {
    at(where, 'config', 'user.email', 'test@example.com');
    at(where, 'config', 'user.name', 'test');
    at(where, 'config', 'commit.gpgsign', 'false');
  };

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'ccd-sync-'));
    remote = join(base, 'remote.git');
    here = join(base, 'here');
    elsewhere = join(base, 'elsewhere');

    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '-q', remote, here]);
    settle(here);
    writeFileSync(join(here, 'f.txt'), 'one\n');
    at(here, 'add', '-A');
    at(here, 'commit', '-qm', 'one');
    at(here, 'push', '-q', '-u', 'origin', 'main');

    execFileSync('git', ['clone', '-q', remote, elsewhere]);
    settle(elsewhere);
  });

  it('sends a commit to the remote', async () => {
    writeFileSync(join(here, 'f.txt'), 'two\n');
    at(here, 'add', '-A');
    at(here, 'commit', '-qm', 'two');

    await pushBranch(here);

    expect(inRemote('log', '--oneline', '-1')).toContain('two');
  });

  it('leaves nothing waiting to be pushed', async () => {
    writeFileSync(join(here, 'f.txt'), 'two\n');
    at(here, 'add', '-A');
    at(here, 'commit', '-qm', 'two');

    await pushBranch(here);

    expect((await statusOf(here))?.ahead).toBe(0);
  });

  it('gives a new branch an upstream on the way', async () => {
    at(here, 'switch', '-q', '-c', 'feature');
    writeFileSync(join(here, 'g.txt'), 'x\n');
    at(here, 'add', '-A');
    at(here, 'commit', '-qm', 'on the branch');
    expect((await statusOf(here))?.upstream).toBeUndefined();

    await pushBranch(here);

    expect((await statusOf(here))?.upstream).toBe('origin/feature');
  });

  it('refuses to push a detached HEAD rather than guessing a branch', async () => {
    at(here, 'checkout', '-q', '--detach');

    await expect(pushBranch(here)).rejects.toThrow(/detached/i);
  });

  it('says to pull when the remote has moved on', async () => {
    writeFileSync(join(elsewhere, 'other.txt'), 'x\n');
    at(elsewhere, 'add', '-A');
    at(elsewhere, 'commit', '-qm', 'theirs');
    at(elsewhere, 'push', '-q');
    writeFileSync(join(here, 'f.txt'), 'mine\n');
    at(here, 'add', '-A');
    at(here, 'commit', '-qm', 'mine');

    await expect(pushBranch(here)).rejects.toThrow(/Pull first/i);
  });

  it('leaves the remote alone when it refuses a push', async () => {
    writeFileSync(join(elsewhere, 'other.txt'), 'x\n');
    at(elsewhere, 'add', '-A');
    at(elsewhere, 'commit', '-qm', 'theirs');
    at(elsewhere, 'push', '-q');
    const before = inRemote('rev-parse', 'main');
    writeFileSync(join(here, 'f.txt'), 'mine\n');
    at(here, 'add', '-A');
    at(here, 'commit', '-qm', 'mine');

    await expect(pushBranch(here)).rejects.toThrow();

    expect(inRemote('rev-parse', 'main')).toBe(before);
  });

  it('brings the remote work down', async () => {
    writeFileSync(join(elsewhere, 'other.txt'), 'x\n');
    at(elsewhere, 'add', '-A');
    at(elsewhere, 'commit', '-qm', 'theirs');
    at(elsewhere, 'push', '-q');

    await pullBranch(here);

    expect(existsSync(join(here, 'other.txt'))).toBe(true);
  });

  it('refuses to pull into a branch that tracks nothing', async () => {
    at(here, 'switch', '-q', '-c', 'orphaned');

    await expect(pullBranch(here)).rejects.toThrow(/tracks nothing/i);
  });

  it('refuses to merge two branches that have both moved', async () => {
    writeFileSync(join(elsewhere, 'other.txt'), 'x\n');
    at(elsewhere, 'add', '-A');
    at(elsewhere, 'commit', '-qm', 'theirs');
    at(elsewhere, 'push', '-q');
    writeFileSync(join(here, 'mine.txt'), 'y\n');
    at(here, 'add', '-A');
    at(here, 'commit', '-qm', 'mine');

    await expect(pullBranch(here)).rejects.toThrow();
  });

  it('leaves the reader on their own commit when it refuses to pull', async () => {
    writeFileSync(join(elsewhere, 'other.txt'), 'x\n');
    at(elsewhere, 'add', '-A');
    at(elsewhere, 'commit', '-qm', 'theirs');
    at(elsewhere, 'push', '-q');
    writeFileSync(join(here, 'mine.txt'), 'y\n');
    at(here, 'add', '-A');
    at(here, 'commit', '-qm', 'mine');
    const before = at(here, 'rev-parse', 'HEAD');

    await expect(pullBranch(here)).rejects.toThrow();

    expect(at(here, 'rev-parse', 'HEAD')).toBe(before);
    expect(at(here, 'log', '--oneline', '-1')).toContain('mine');
  });

  it('says a folder outside a repository is not one', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ccd-plain-'));
    try {
      await expect(pushBranch(plain)).rejects.toThrow(/not in a git repository/i);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('saying what git said, to someone who was not watching a terminal', () => {
  const said = (stderr: string) => explainGit(Object.assign(new Error('Command failed'), { stderr }));

  it('names a sign-in failure', () => {
    expect(said("fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled")).toMatch(
      /sign in/i,
    );
  });

  it('names a rejected SSH key', () => {
    expect(said('git@github.com: Permission denied (publickey).')).toMatch(/SSH key/i);
  });

  it('names being offline', () => {
    expect(said("fatal: unable to access 'https://x/y.git/': Could not resolve host: x")).toMatch(/connection/i);
  });

  it('names a repository it cannot see', () => {
    expect(said('remote: Repository not found.\nfatal: repository not found')).toMatch(/not found/i);
  });

  it('tells a rejected push to pull first', () => {
    expect(said(' ! [rejected]        main -> main (fetch first)')).toMatch(/Pull first/i);
  });

  it('does not suggest forcing a rejected push', () => {
    expect(said(' ! [rejected]        main -> main (fetch first)')).not.toMatch(/force/i);
  });

  it('passes git\'s own words through when it recognises nothing', () => {
    expect(said('fatal: something specific and unusual happened')).toBe('something specific and unusual happened');
  });

  it('says something rather than nothing for an empty failure', () => {
    expect(said('')).toBeTruthy();
  });
});

