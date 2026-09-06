import { execFile } from 'node:child_process';
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

async function git(root: string, args: string[]): Promise<string> {
  // execFile rather than exec: paths contain spaces, and nothing here should reach a shell.
  const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
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

/** Paths git is not tracking, which a diff against a commit would never mention. */
async function untracked(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

/**
 * What the working tree held at one moment, so a later diff can be taken against it.
 *
 * `stash create` writes a commit for the current tree and leaves the tree alone: nothing
 * is stashed, restored or reverted, and the stash list is untouched. That commit is the
 * cheapest possible record of "before", since git already stores the content.
 *
 * Files git is not tracking are held separately, because a diff against a commit cannot
 * see them: without this, a file the reader left lying about before the turn would be
 * reported as something the agent created.
 */
export interface Snapshot {
  commit: string;
  untracked: string[];
}

export async function takeSnapshot(workspace: Workspace, keepAs: string): Promise<Snapshot | null> {
  try {
    // Empty when the tree is clean: there is nothing to record beyond the commit itself.
    const created = (await git(workspace.root, ['stash', 'create'])).trim();
    const commit = created || workspace.head;

    // The object is unreferenced and would be collected; a ref keeps it until it is dropped.
    await git(workspace.root, ['update-ref', refFor(keepAs), commit]);

    return { commit, untracked: await untracked(workspace.root) };
  } catch {
    return null;
  }
}

function refFor(name: string): string {
  return `refs/copilot-desktop/${name.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

export interface Change {
  path: string;
  /** Added covers both a new file and one git was not tracking before. */
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

const STATUS: Record<string, Change['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

/**
 * What changed since a snapshot: the agent's work, and only the agent's.
 *
 * Anything already modified when the snapshot was taken is inside it, so it does not
 * appear here. That is the whole point - a session's diff should not include whatever
 * the reader had half-finished when they started.
 */
export async function changesSince(workspace: Workspace, snapshot: Snapshot): Promise<Change[]> {
  const changes: Change[] = [];

  const named = await git(workspace.root, ['diff', '--name-status', '-z', snapshot.commit]);
  const fields = named.split('\0').filter(Boolean);
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i]![0]!;
    const status = STATUS[code];
    if (!status) continue;
    // A rename is reported as a code, then the old path, then the new one.
    const path = status === 'renamed' ? fields[i + 2] : fields[i + 1];
    if (status === 'renamed') i += 2;
    else i += 1;
    if (path) changes.push({ path, status });
  }

  // A file git still is not tracking cannot appear above, so new ones are found by
  // comparing against the set that was already there.
  const before = new Set(snapshot.untracked);
  for (const path of await untracked(workspace.root)) {
    if (!before.has(path)) changes.push({ path, status: 'added' });
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** The patch for one file, as git would show it. */
export async function diffOf(workspace: Workspace, snapshot: Snapshot, path: string): Promise<string> {
  try {
    const tracked = await git(workspace.root, ['diff', snapshot.commit, '--', path]);
    if (tracked.trim()) return tracked;
    // Untracked files have no diff of their own; git will produce one against nothing.
    return await git(workspace.root, ['diff', '--no-index', '--', nullDevice(), path]).catch(() => '');
  } catch {
    return '';
  }
}

function nullDevice(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/** Forget a snapshot's ref, so git may collect the objects it was holding. */
export async function dropSnapshot(workspace: Workspace, keepAs: string): Promise<void> {
  await git(workspace.root, ['update-ref', '-d', refFor(keepAs)]).catch(() => undefined);
}
