/**
 * What the agent changed, taken from the tools that say so.
 *
 * The file tools report a unified diff of their own work, with absolute paths, whether or
 * not the file is in a repository. That makes them the general answer to "what did this
 * agent touch": a text file in a downloads folder is recorded exactly as a source file in
 * a checkout is, and the attribution is beyond doubt because the change is the tool's own
 * account of what it did.
 *
 * Shell commands report nothing of the sort, so they are covered by the repository
 * snapshot instead, which sees writes however they were made but only inside a checkout.
 */

/** The tools that report what they wrote. Anything else is invisible here. */
const REPORTING_TOOLS = new Set(['edit', 'create', 'apply_patch', 'write', 'str_replace']);

export interface FilePatch {
  /** Absolute, as the tool reported it. */
  path: string;
  patch: string;
  status: 'added' | 'modified' | 'deleted';
}

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Split a tool's report into one patch per file.
 *
 * A single call can touch several files, and each arrives as its own `diff --git` section
 * in the same string.
 */
export function splitPatches(detail: string): FilePatch[] {
  if (!detail.includes('diff --git')) return [];

  const patches: FilePatch[] = [];
  let current: string[] = [];
  let path: string | null = null;

  const finish = () => {
    if (path && current.length > 0) patches.push({ path, patch: current.join('\n'), status: statusOf(current) });
  };

  for (const line of detail.split('\n')) {
    const header = HEADER.exec(line);
    if (header) {
      finish();
      // The b-side is where the file ended up, which is its name after a rename.
      path = normalise(header[2] ?? header[1]!);
      current = [line];
      continue;
    }
    if (path) current.push(line);
  }
  finish();

  return patches;
}

/** Git writes forward slashes even on Windows; the rest of the app speaks in real paths. */
function normalise(path: string): string {
  return path.replace(/\//g, '\\');
}

function statusOf(lines: string[]): FilePatch['status'] {
  if (lines.some((line) => line.startsWith('new file mode'))) return 'added';
  if (lines.some((line) => line.startsWith('deleted file mode'))) return 'deleted';
  // A file created by a tool that does not say so still starts from nothing.
  if (lines.some((line) => line.startsWith('--- /dev/null'))) return 'added';
  return 'modified';
}

/** Whether a completed tool call is one that reports its own changes. */
export function reportsChanges(toolName: string | null | undefined): boolean {
  return Boolean(toolName && REPORTING_TOOLS.has(toolName));
}

/**
 * Fold a tool's patches into what a session has recorded so far.
 *
 * Patches accumulate in the order they happened, because that is the order they have to be
 * undone in, and because a file edited three times has three separate accounts of what was
 * done to it rather than one.
 */
export function recordPatches(recorded: FilePatch[], reported: FilePatch[]): FilePatch[] {
  return reported.length === 0 ? recorded : [...recorded, ...reported];
}

/** The files a set of patches touched, newest status winning. */
export function touchedFiles(patches: FilePatch[]): { path: string; status: FilePatch['status'] }[] {
  const byPath = new Map<string, FilePatch['status']>();

  for (const patch of patches) {
    const first = byPath.get(patch.path);
    // Created and then edited is still a file the agent created; deleted last is deleted.
    if (patch.status === 'deleted') byPath.set(patch.path, 'deleted');
    else if (first === undefined) byPath.set(patch.path, patch.status);
    else if (first === 'deleted') byPath.set(patch.path, 'modified');
  }

  return [...byPath].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
}
