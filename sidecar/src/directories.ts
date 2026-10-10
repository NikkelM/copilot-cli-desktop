import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep, dirname } from 'node:path';
import type { Dirent } from 'node:fs';

/** Whether names on this platform normally differ only by letter case. */
export const directoryCaseSensitive = process.platform !== 'win32';

/** The separator a newly completed path should use when the reader has not chosen one. */
export const directorySeparator = sep;

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: directoryCaseSensitive ? 'variant' : 'base',
});

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Expand the home shorthand without involving a shell. */
function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? home + path.slice(1) : path;
}

/**
 * Resolve the directory being browsed against the session rather than the sidecar process.
 *
 * A relative path without a session directory has no honest base, so it offers nothing
 * instead of browsing whichever installation directory happened to launch the sidecar.
 */
export function resolveDirectory(cwd: string | undefined, path: string, home = homedir()): string | null {
  const expanded = expandHome(path, home);
  if (!cwd && !isAbsolute(expanded)) return null;
  return resolve(cwd ?? process.cwd(), expanded || '.');
}

/** Whether a directory entry can itself be browsed. */
async function browsable(entry: Dirent, parent: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;

  try {
    return (await stat(join(parent, entry.name))).isDirectory();
  } catch (error: unknown) {
    // A broken, looping or inaccessible link cannot lead anywhere useful in this menu.
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(errorCode(error) ?? '')) return false;
    throw error;
  }
}

/**
 * Child directories available below a partially typed path.
 *
 * The caller filters the returned names while more of the final segment is typed, so one
 * disk read serves every keystroke until the reader crosses into another directory.
 */
export async function listDirectories(cwd: string | undefined, path: string): Promise<string[]> {
  // Without the way up, which belongs to a menu somebody is browsing rather than to a
  // command argument: `..` in a path a command will act on is a worse answer than typing it.
  return (await listEntries(cwd, path))
    .filter((entry) => entry.directory && entry.name !== '..')
    .map((entry) => entry.name);
}

/** A child of the directory being browsed, and whether it can be browsed in turn. */
export interface Entry {
  name: string;
  directory: boolean;
}

/**
 * Everything below a partially typed path, files included (#135).
 *
 * The same read as `listDirectories`, which is built on this: naming a file is what `@`
 * is for, and the two differ only in what they keep. Directories lead the list, because a
 * path being typed is walked before it is finished - and a folder of a hundred files with
 * one subdirectory among them is one the reader would otherwise have to hunt through.
 */
export async function listEntries(cwd: string | undefined, path: string): Promise<Entry[]> {
  return (await readFolder(cwd, path)).entries;
}

/**
 * The same read, with the folder it actually resolved to.
 *
 * The caller needs that to say where a chosen file really is. A path typed relative to the
 * session reads back to the agent against the same place, which is fine until one climbs
 * out with `..` - at which point only an absolute answer is unambiguous, and this is the one
 * place that knows it (#135).
 */
export async function readFolder(
  cwd: string | undefined,
  path: string,
): Promise<{ entries: Entry[]; directory: string }> {
  const parent = resolveDirectory(cwd, path);
  if (!parent) return { entries: [], directory: '' };

  let entries: Dirent[];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error: unknown) {
    // A half-typed path simply has no completions yet.
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return { entries: [], directory: parent };
    throw error;
  }

  const found = await Promise.all(
    entries.map(async (entry) => ({ name: entry.name, directory: await browsable(entry, parent) })),
  );

  const sorted = found.sort(
    (one, other) => Number(other.directory) - Number(one.directory) || collator.compare(one.name, other.name),
  );

  /*
   * The way back up, which `readdir` never reports and which a menu is expected to offer.
   * Without it, typing `@..` filtered every real name away and left nothing on screen - so
   * the one path that cannot be reached by walking down could not be reached at all.
   *
   * First, and ahead of the sort, because it is navigation rather than a name among names.
   * Absent at a root, where it would only lead back to itself.
   */
  const up = dirname(parent) === parent ? [] : [{ name: '..', directory: true }];

  return { entries: [...up, ...sorted], directory: parent };
}
