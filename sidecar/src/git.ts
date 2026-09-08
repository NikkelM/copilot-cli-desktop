import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TreeState } from '../../shared/protocol.js';

const run = promisify(execFile);

/**
 * Run git in a directory and hand back what it printed.
 *
 * Shared rather than written per caller so the buffer limit holds everywhere: reading a
 * large repository's status overruns the default buffer.
 */
export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 });
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
