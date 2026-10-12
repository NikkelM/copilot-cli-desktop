/**
 * Reading a unified diff for what it says about files, rather than for how to draw it.
 *
 * Shared because both halves need it and must agree: the app draws a turn's changes from
 * the patches in its transcript, and the sidecar follows a running turn from the same
 * patches as the tools report them (#140). Two readings of one patch would be two answers
 * to one question.
 *
 * Drawing a patch is the app's own business and stays there - this is only about which
 * files a patch is about, and how much of each one moved.
 */

/** What a patch does to a file, in the terms the changes list already uses. */
export type PatchStatus = 'created' | 'modified' | 'deleted';

/**
 * The tools that write files, as the logs here actually name them.
 *
 * Shared for the same reason the reading below is: the sidecar watches a running turn's
 * writes and the app reads a delegated run's out of its transcript, and a tool missing from
 * one list but not the other is a write that silently stops being counted on one side.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['edit', 'create', 'apply_patch']);

/** One file inside a patch, with the part of the patch that is about it. */
export interface PatchFile {
  path: string;
  status: PatchStatus;
  /** Only the hunks about this file, so several files in one patch stay apart. */
  patch: string;
  added: number;
  removed: number;
}

/** What git writes at an end where the file does not exist. */
const NOWHERE = /^\/?dev\/null$/;

/**
 * The files a patch is about, with each one's own hunks and counts.
 *
 * A patch is not always about one file. `apply_patch` is handed a whole envelope, and
 * measured over the 1,273 calls on this machine only two thirds name a single file: a fifth
 * name two, and the rest up to eighteen.
 *
 * Read from the `---` and `+++` lines rather than the `diff --git` line above them. That
 * line holds both paths with only a space between, which is ambiguous for a path that
 * contains one, and on Windows they routinely do.
 */
export function splitByFile(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let lines: string[] = [];
  let before: string | null = null;
  let after: string | null = null;

  const close = () => {
    // The `+++` side is where the file ended up, which is its name unless it was deleted.
    const named = pathOf(after) ?? pathOf(before);
    if (named && lines.length > 0) {
      files.push({
        path: named,
        status: pathOf(before) === null ? 'created' : pathOf(after) === null ? 'deleted' : 'modified',
        patch: lines.join('\n'),
        ...count(lines),
      });
    }
    lines = [];
    before = null;
    after = null;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      close();
      lines.push(line);
      continue;
    }

    if (line.startsWith('--- ')) before = line.slice(4);
    else if (line.startsWith('+++ ')) after = line.slice(4);
    lines.push(line);
  }

  close();
  return files;
}

/**
 * How many lines a patch adds and removes.
 *
 * The header's own `---` and `+++` lines begin with the same characters as a removed and an
 * added line, so they are skipped rather than counted as a change to the file.
 */
function count(lines: string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }

  return { added, removed };
}

/** A path from a `---` or `+++` line, without its prefix, or null where there is no file. */
function pathOf(line: string | null): string | null {
  if (line === null) return null;
  const path = line.replace(/^[ab]\//, '').trim();
  return NOWHERE.test(path) ? null : path || null;
}
