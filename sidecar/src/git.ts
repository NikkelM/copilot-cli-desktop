import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TreeState } from '../../shared/protocol.js';

const run = promisify(execFile);

/**
 * Run git in a directory and hand back what it printed.
 *
 * Shared rather than written per caller so the buffer limit and the private-index escape
 * hatch below hold everywhere: a diff of a large change overruns the default buffer, and a
 * caller that stages must not disturb the staging area the reader is using.
 */
export async function git(root: string, args: string[], indexFile?: string): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env,
  });
  return stdout;
}

/**
 * What git says about a directory now, or null when it is not in a repository.
 *
 * One call rather than a branch lookup and a status walk: the porcelain format carries the
 * branch in its header, and status is the expensive half on a large repository. Unlike a
 * snapshot this asks nothing of HEAD, so a repository whose first commit is still to come
 * reports its branch rather than nothing.
 */
export async function treeStateOf(cwd: string): Promise<TreeState | null> {
  let output: string;
  try {
    output = await git(cwd, ['status', '--porcelain=v2', '--branch']);
  } catch {
    return null;
  }

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
  };
}
