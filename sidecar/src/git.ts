/**
 * What state a working directory is in, by asking git directly.
 *
 * Deliberately overlaps the SDK's `session.workspaces.diff` with `mode: 'unstaged'` and
 * `'branch'` (#143). The same reason as everywhere else here: the sidebar's branch line has
 * to be right for a session nobody has opened, and the SDK cannot answer without loading it.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { canAmend, type FileDiff, type RepoFile, type RepoStatus, type TreeState } from '../../shared/protocol.js';

const run = promisify(execFile);

/**
 * Run git in a directory and hand back what it printed.
 *
 * Shared rather than written per caller so the buffer limit holds everywhere: reading a
 * large repository's status overruns the default buffer.
 *
 * The timeout is for the calls that can wait on a person rather than on a process - a commit
 * that signs may raise a passphrase prompt. Everything else is given git's own patience,
 * which is none.
 */
export async function git(root: string, args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });
  return stdout;
}

/**
 * The `owner/repo` a remote URL names on GitHub, or null for anywhere else.
 *
 * Both forms git writes are accepted - `https://github.com/o/r.git` and `git@github.com:o/r`
 * - along with the enterprise-ish `ssh://git@github.com/o/r`. Anything not on github.com is
 * a repository with no page here, which is a normal thing to be rather than a failure.
 */
export function githubSlug(url: string): string | null {
  const match = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(
    url.trim(),
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Which GitHub repository a checkout belongs to, preferring origin.
 *
 * One config read rather than a call per remote: a fork usually has both `origin` and
 * `upstream`, and the one the reader is working in is the one they want to open.
 */
async function githubRemote(cwd: string): Promise<string | null> {
  let output: string;
  try {
    output = await git(cwd, ['config', '--get-regexp', '^remote\\..*\\.url']);
  } catch {
    // git exits non-zero when nothing matches, which is a repository without remotes.
    return null;
  }

  let fallback: string | null = null;
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;

    const slug = githubSlug(line.slice(space + 1));
    if (!slug) continue;
    if (line.slice(0, space) === 'remote.origin.url') return slug;
    fallback ??= slug;
  }

  return fallback;
}

/**
 * What one of git's status letters means about a path.
 *
 * `.` is unchanged, and unmerged entries carry their own pair which says which side did what
 * - a distinction a panel offering to stage things does not draw, so `u` lines are reported
 * as unmerged whatever the letters say.
 */
const STAGED: Record<string, RepoFile['staged']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

const UNSTAGED: Record<string, RepoFile['unstaged']> = {
  M: 'modified',
  D: 'deleted',
  T: 'typechange',
};

/**
 * Read one porcelain v2 entry.
 *
 * The fields are space-separated and the path is last, except for a rename or copy, where
 * the original follows it after a tab. A path may contain spaces, so it is taken as the rest
 * of the line from a known field count rather than by splitting the whole line.
 */
function entryOf(line: string): RepoFile | null {
  const kind = line[0];

  if (kind === '?') return { path: line.slice(2), unstaged: 'untracked' };
  if (kind === 'u') {
    // Unmerged: eleven fields before the path, and no staging decision to offer until it
    // is resolved.
    const path = after(line, 10);
    return path ? { path, unstaged: 'unmerged' } : null;
  }
  if (kind !== '1' && kind !== '2') return null;

  const marks = line.slice(2, 4);
  // A rename carries a score field before the path, so the path begins one field later.
  const rest = after(line, kind === '1' ? 8 : 9);
  if (!rest) return null;

  const [path, from] = kind === '2' ? splitOnce(rest, '\t') : [rest, undefined];
  if (!path) return null;

  const staged = STAGED[marks[0] ?? ''];
  const unstaged = UNSTAGED[marks[1] ?? ''];

  return {
    path,
    ...(staged ? { staged } : {}),
    ...(unstaged ? { unstaged } : {}),
    ...(from ? { from } : {}),
  };
}

/** Everything after the given number of space-separated fields, which is where a path starts. */
function after(line: string, fields: number): string | null {
  let at = 0;
  for (let field = 0; field < fields; field++) {
    const space = line.indexOf(' ', at);
    if (space === -1) return null;
    at = space + 1;
  }
  return line.slice(at) || null;
}

/** Split on the first occurrence only, since a path may contain the separator again. */
function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}

/**
 * Read the whole of what git says about a working tree.
 *
 * The same one call `treeStateOf` makes, and for the same reason: the porcelain format
 * carries the branch, the upstream and the ahead/behind counts in its header, so asking for
 * them separately would walk the tree twice.
 */
export function parseStatus(output: string): RepoStatus | null {
  let head = '';
  let oid = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  const files: RepoFile[] = [];

  for (const line of output.split('\n')) {
    if (!line) continue;

    if (line.startsWith('# branch.head ')) head = line.slice(14).trim();
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim();
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const counts = /\+(\d+)\s+-(\d+)/.exec(line.slice(12));
      ahead = Number(counts?.[1] ?? 0);
      behind = Number(counts?.[2] ?? 0);
    } else if (line[0] !== '#') {
      // Anything that is not a header is an entry, and `entryOf` refuses the kinds it does
      // not know. Ignored files are not among them: git omits those unless asked.
      const entry = entryOf(line);
      if (entry) files.push(entry);
    }
  }

  if (!head) return null;

  const detached = head === '(detached)';
  return {
    branch: detached ? oid.slice(0, 8) : head,
    detached,
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    // Alphabetical, so a panel reads the same after a change as before it. Git's own order
    // is the index walk, which puts a file wherever the tree happens to hold it.
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/**
 * What git says about a working tree now, or null when it is not in a repository.
 *
 * Read-only by construction: `status` cannot change anything, which is why this can land
 * before any of the operations that can (#42).
 */
export async function statusOf(cwd: string): Promise<RepoStatus | null> {
  try {
    return parseStatus(await git(cwd, ['status', '--porcelain=v2', '--branch']));
  } catch {
    // Not a repository, or no git on the machine. Both are things to degrade around rather
    // than report: a session in a plain folder is an ordinary session.
    return null;
  }
}

/**
 * Paths split into runs short enough for one command line.
 *
 * Windows caps a command at about 32k characters and node reports the overflow as
 * `ENAMETOOLONG`, which says nothing about staging, so a repository with a few hundred
 * changed files would break "stage all" in a way that looked like git's fault. Half the cap
 * leaves room for the executable, the subcommand, and the flags.
 */
export function inRuns(paths: string[]): string[][] {
  const LIMIT = 16_000;
  const runs: string[][] = [];
  let run: string[] = [];
  let length = 0;

  for (const path of paths) {
    // A single path over the limit still has to go somewhere: git can refuse it, but this
    // must not silently drop it.
    if (run.length > 0 && length + path.length + 3 > LIMIT) {
      runs.push(run);
      run = [];
      length = 0;
    }
    run.push(path);
    length += path.length + 3;
  }

  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * Put paths' changes into the index.
 *
 * `git add` covers every case including a deletion: staging a file that is gone from disk
 * records the removal, which is what a reader clicking a `D` row is asking for.
 *
 * Takes a list rather than a path so that staging everything is one git call rather than
 * one per file, and so that the paths staged are the ones the reader was looking at. `git
 * add -A` would be shorter and wrong: it stages whatever is there now, which after an agent
 * has written three more files is not what the panel showed.
 */
export async function stagePaths(cwd: string, paths: string[]): Promise<void> {
  for (const run of inRuns(paths)) {
    await git(cwd, ['add', '--', ...run]);
  }
}

/**
 * Take paths' changes back out of the index, without touching the working tree.
 *
 * `--staged` is the whole of the safety here: it is what confines `restore` to the index.
 * Without it, or with `--worktree`, the same command overwrites files - so the flag is not a
 * detail of this call but the reason this call is allowed to exist.
 *
 * A file whose staged change was its deletion keeps that deletion in the working tree. It is
 * the index this puts back, never the file.
 */
export async function unstagePaths(cwd: string, paths: string[]): Promise<void> {
  for (const run of inRuns(paths)) {
    try {
      await git(cwd, ['restore', '--staged', '--', ...run]);
    } catch (error: unknown) {
      // Before the first commit there is no HEAD to restore an entry from, and git refuses
      // rather than guessing. Everything staged then is an addition, so dropping the entry is
      // what unstaging means. `update-index` cannot write to the working tree either.
      if (!String(error).includes('could not resolve HEAD')) throw error;
      await git(cwd, ['update-index', '--force-remove', '--', ...run]);
    }
  }
}

/**
 * Commit what is staged.
 *
 * Runs `git commit` as the reader would, so the repository's own hooks and signing
 * configuration apply. Nothing here suppresses either: a repository that signs its commits
 * should sign the ones made from this panel, and a hook that rejects a commit should reject
 * this one too.
 *
 * Signing can wait on a passphrase prompt, which is a person rather than a process, so this
 * is given several minutes rather than the usual patience. Left unbounded a locked keyring
 * would hang the sidecar for as long as the app was open.
 */
export async function commitStaged(cwd: string, message: string, amend: boolean): Promise<void> {
  const text = message.trim();
  if (!text) throw new Error('A commit needs a message.');

  const status = await statusOf(cwd);
  if (amend && !canAmend(status)) {
    throw new Error('That commit has already been pushed. Amending it would rewrite history others may have.');
  }
  // Amending with nothing staged is a real thing to do - it rewords the last commit - but
  // committing with nothing staged is not, and git's own error for it says less than this.
  if (!amend && !status?.files.some((file) => file.staged)) {
    throw new Error('Nothing is staged.');
  }

  await git(cwd, ['commit', ...(amend ? ['--amend'] : []), '-m', text], { timeoutMs: 5 * 60_000 });
}

/**
 * The diff for one path, on the side the reader asked about.
 *
 * Two questions rather than one, because the panel draws two lists and a file can be in
 * both: staged compares the index against HEAD, unstaged compares the working tree against
 * the index. Asking the wrong one shows the reader a diff for the half they are not
 * looking at, which is worse than none.
 *
 * An untracked file has nothing to compare against, so it is read from disk and reported as
 * an addition - which is what it is, and what the reader expects to see.
 */
export async function diffOf(cwd: string, path: string, staged: boolean): Promise<FileDiff> {
  // `--no-ext-diff` and `--no-color` because the reader's own git config may install an
  // external differ or colour codes, and this output is parsed rather than printed.
  const base = ['diff', '--no-ext-diff', '--no-color', '--no-textconv'];

  try {
    const patch = await git(cwd, [...base, ...(staged ? ['--cached'] : []), '--', path]);
    if (patch.trim()) return { patch, stale: false };
  } catch {
    return { patch: null, reason: 'gone', stale: false };
  }

  // No patch and not staged: either nothing differs, or git has never heard of the file.
  if (staged) return { patch: null, stale: false };

  try {
    const contents = await readFile(join(cwd, path), 'utf8');
    if (contents.includes('\0')) return { patch: null, reason: 'binary', stale: false };

    const lines = contents.split('\n');
    // A trailing newline leaves an empty last element, which is not a line of the file.
    if (lines[lines.length - 1] === '') lines.pop();

    const header = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`;
    return { patch: header + lines.map((line) => `+${line}`).join('\n'), stale: false };
  } catch {
    return { patch: null, reason: 'gone', stale: false };
  }
}

/**
 * What git says about a directory now, or null when it is not in a repository.
 *
 * One status call rather than a branch lookup and a status walk: the porcelain format
 * carries the branch in its header, and status is the expensive half on a large repository.
 * Nothing is asked of HEAD, so a repository whose first commit is still to come reports its
 * branch rather than nothing.
 *
 * The remote is read alongside it rather than after, since neither waits on the other.
 */
export async function treeStateOf(cwd: string): Promise<TreeState | null> {
  // allSettled rather than all: a rejection from either would return while the other git
  // process was still running, leaving it holding the directory. A caller that deleted the
  // directory straight afterwards then failed with EPERM, which a test caught.
  const [status, remote] = await Promise.allSettled([
    git(cwd, ['status', '--porcelain=v2', '--branch']),
    githubRemote(cwd),
  ]);

  if (status.status === 'rejected') return null;
  const output = status.value;

  let head = '';
  let oid = '';
  let modified = false;
  let untracked = false;
  let staged = false;

  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice(14).trim();
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim();
    else if (line.startsWith('? ')) untracked = true;
    else if (line[1] === ' ' && (line[0] === '1' || line[0] === '2' || line[0] === 'u')) {
      // Changed, renamed and unmerged entries all carry the same two status letters, the
      // first for the index and the second for the working tree. A dot means unchanged.
      if (line[2] !== '.') staged = true;
      if (line[3] !== '.') modified = true;
    }
  }

  if (!head) return null;

  const detached = head === '(detached)';
  return {
    branch: detached ? oid.slice(0, 8) : head,
    detached,
    modified,
    untracked,
    staged,
    remote: remote.status === 'fulfilled' ? remote.value : null,
  };
}












