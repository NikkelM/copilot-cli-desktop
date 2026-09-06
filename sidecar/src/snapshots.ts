import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Where a session's work happens, if git can tell us anything about it.
 *
 * The CLI takes this route too - its snapshots refuse to start without a repository and
 * without commits - because a diff needs something to be a diff against.
 */
export interface Workspace {
  root: string;
  head: string;
}

/**
 * What the working tree held at one moment.
 *
 * A commit whose tree is exactly the working tree, built through an index of its own so
 * neither the real index nor the tree itself is touched. Everything git would track is in
 * it, including files not yet added, which is what lets a rewind put them back.
 */
export interface Snapshot {
  commit: string;
  at: string;
}

async function git(root: string, args: string[], indexFile?: string): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    // A private index leaves the repository's own staging area alone: the reader may have
    // staged something, and taking a snapshot must not disturb it.
    env: indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env,
  });
  return stdout;
}

/** The repository a directory belongs to, or null if it is not in one, or has no commits. */
export async function workspaceOf(cwd: string): Promise<Workspace | null> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (!root) return null;
    // A repository with no commits has nothing to compare against and no HEAD to name.
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
    return head ? { root, head } : null;
  } catch {
    return null;
  }
}

/**
 * A tree object matching the working tree exactly, ignored files aside.
 *
 * The index is kept between calls rather than rebuilt: git stats what it already knows and
 * only reads what changed, which took a repository of this size from 444ms to 115ms.
 */
async function captureTree(workspace: Workspace, indexFile: string): Promise<string> {
  await git(workspace.root, ['read-tree', 'HEAD'], indexFile).catch(() => undefined);
  await git(workspace.root, ['add', '-A'], indexFile);
  return (await git(workspace.root, ['write-tree'], indexFile)).trim();
}

/** A name git will keep, so the objects behind a snapshot are not collected. */
function refFor(name: string): string {
  return `refs/copilot-desktop/${name.replace(/[^A-Za-z0-9._/-]/g, '-')}`;
}

/**
 * Forget the snapshots a session no longer needs.
 *
 * Every point holds a ref, and a ref stops git collecting the tree behind it, so a long
 * session left to itself pins a copy of the working tree per turn forever. Keeping the
 * baseline and a run of recent turns is enough for the two things points are for -
 * measuring a session's work, and going back a few steps.
 */
export async function dropSnapshots(workspace: Workspace, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await git(workspace.root, ['update-ref', '-d', refFor(name)]).catch(() => undefined);
  }
}

export async function takeSnapshot(
  workspace: Workspace,
  indexFile: string,
  keepAs: string,
): Promise<Snapshot | null> {
  try {
    const tree = await captureTree(workspace, indexFile);
    const commit = (
      await git(workspace.root, ['commit-tree', tree, '-p', workspace.head, '-m', `snapshot ${keepAs}`])
    ).trim();

    // The commit is unreferenced and would be collected; a ref holds it until it is dropped.
    await git(workspace.root, ['update-ref', refFor(keepAs), commit]);

    return { commit, at: new Date().toISOString() };
  } catch {
    return null;
  }
}

export interface Change {
  path: string;
  /** Added covers both a new file and one git was not tracking before. */
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

const STATUS: Record<string, Change['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

function parseNameStatus(output: string): Change[] {
  const changes: Change[] = [];
  const fields = output.split('\0').filter(Boolean);

  for (let i = 0; i < fields.length; i += 1) {
    const status = STATUS[fields[i]![0]!];
    if (!status) continue;
    // A rename is reported as a code, then the old path, then the new one.
    const path = status === 'renamed' ? fields[i + 2] : fields[i + 1];
    i += status === 'renamed' ? 2 : 1;
    if (path) changes.push({ path, status });
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * What changed since a snapshot: the agent's work, and only the agent's.
 *
 * Both sides are trees of the whole working directory, so this sees files git was never
 * tracking as readily as ones it was. Anything already changed when the snapshot was taken
 * is inside it and does not appear - which is the point, since a session's diff should not
 * include whatever the reader had half-finished when it started.
 */
export async function changesSince(
  workspace: Workspace,
  snapshot: Snapshot,
  indexFile: string,
): Promise<Change[]> {
  const now = await captureTree(workspace, indexFile);
  return parseNameStatus(await git(workspace.root, ['diff', '--name-status', '-z', snapshot.commit, now]));
}

/** The patch for one changed file, as git would show it. */
export async function diffOf(
  workspace: Workspace,
  snapshot: Snapshot,
  path: string,
  indexFile: string,
): Promise<string> {
  try {
    const now = await captureTree(workspace, indexFile);
    return await git(workspace.root, ['diff', snapshot.commit, now, '--', path]);
  } catch {
    return '';
  }
}

/**
 * Put the working tree back to what a snapshot holds.
 *
 * Only the paths that differ are touched, so work elsewhere in the repository is left
 * alone. A file that did not exist in the snapshot is removed rather than left behind,
 * since leaving it would give neither the old state nor the new one.
 */
export async function restoreTo(
  workspace: Workspace,
  snapshot: Snapshot,
  indexFile: string,
): Promise<Change[]> {
  const changes = await changesSince(workspace, snapshot, indexFile);
  if (changes.length === 0) return [];

  const added = changes.filter((c) => c.status === 'added').map((c) => c.path);
  const existed = changes.filter((c) => c.status !== 'added').map((c) => c.path);

  if (existed.length > 0) {
    await git(workspace.root, ['checkout', snapshot.commit, '--', ...existed]);
    // checkout stages what it restores, and the reader's staging area is not ours to move.
    await git(workspace.root, ['reset', '--quiet', 'HEAD', '--', ...existed]).catch(() => undefined);
  }

  for (const path of added) {
    // Untracked files are ordinary files as far as git is concerned, so remove them plainly.
    await rm(join(workspace.root, path), { force: true }).catch(() => undefined);
    await git(workspace.root, ['rm', '-f', '--quiet', '--ignore-unmatch', '--', path]).catch(() => undefined);
  }

  return changes;
}

