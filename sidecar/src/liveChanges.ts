import type { SessionChange } from '../../shared/protocol.js';
import { splitByFile, type PatchStatus } from '../../shared/patch.js';

/**
 * What a turn has changed while it is still running (#140).
 *
 * The CLI writes a turn's snapshot when the *next* turn begins, so the rewind store on disk
 * is always one turn behind. Measured on this machine during a running turn: the newest
 * snapshot in `index.json` was stamped at the moment the current turn's message arrived and
 * described the previous turn's work. Watching a long turn, that is minutes of a panel
 * saying nothing while the agent rewrites half the repository.
 *
 * The blobs the CLI writes mid-turn cannot help: they are content-addressed and carry no
 * path and no turn, so nothing can be attributed to them until the index names them. What
 * can help is the tools' own reports. Every successful write returns a unified diff -
 * 27,303 of them in the logs here, without exception - and that says which files moved,
 * what happened to each, and by how much.
 *
 * Read from the diff rather than from the tool's arguments, which is both simpler and the
 * only thing that works for all three: `edit` and `create` name their file in an argument,
 * `apply_patch` is handed one string and names its files inside it. The diff is the same
 * shape whichever wrote it.
 *
 * Held in the sidecar rather than in the app because the sidecar sees every session's
 * events all the time. The app only has the session on screen, and only the pages of it
 * that have been read, so a turn running in a session somebody navigated away from would
 * lose its changes to the gap.
 */

/** The tools that write files, as the logs here actually name them. */
const WRITES: ReadonlySet<string> = new Set(['edit', 'create', 'apply_patch']);

/** One file a running turn has touched, as the tools that touched it reported. */
interface LiveFile {
  path: string;
  status: PatchStatus;
  added: number;
  removed: number;
  changedAt: string;
  /**
   * Every write to it this turn, in the order they were made.
   *
   * Kept apart rather than joined here: the second write's line numbers count a file the
   * first already changed. The app joins them for drawing, with the same code it uses for
   * the summary at the end of a turn, so the two views cannot disagree.
   */
  patches: string[];
}

/** Which calls in flight are worth looking at when they finish. */
const pending = new Map<string, Set<string>>();
/** What the finished ones have done, by session. */
const touched = new Map<string, Map<string, LiveFile>>();

/**
 * Take note of a tool starting.
 *
 * Only which calls are file writes. What they did is read from the diff they report when
 * they finish, which is also the only moment anything has actually changed.
 */
export function noteToolStart(sessionId: string, toolCallId: string, toolName: string): void {
  if (!WRITES.has(toolName)) return;

  let calls = pending.get(sessionId);
  if (!calls) pending.set(sessionId, (calls = new Set()));
  calls.add(toolCallId);
}

/**
 * Take note of it finishing, and say whether the answer moved.
 *
 * The caller uses that to decide whether to tell anybody. A tool that wrote nothing, failed,
 * or was never a file tool is not worth a notification.
 */
export function noteToolEnd(
  sessionId: string,
  toolCallId: string,
  success: boolean,
  patch: string | undefined,
  at: string,
): boolean {
  const calls = pending.get(sessionId);
  if (!calls?.delete(toolCallId)) return false;
  if (calls.size === 0) pending.delete(sessionId);

  // A failed write left the file as it was, whatever it meant to do, and reports no diff.
  if (!success || !patch) return false;

  const files = splitByFile(patch);
  if (files.length === 0) return false;

  let held = touched.get(sessionId);
  if (!held) touched.set(sessionId, (held = new Map()));
  let moved = false;

  for (const file of files) {
    // Writing a file without changing it reports a patch of nothing but context. Counting
    // it would claim a change that is not there.
    if (file.added === 0 && file.removed === 0) continue;
    moved = true;

    const before = held.get(file.path);
    if (!before) {
      held.set(file.path, {
        path: file.path,
        status: file.status,
        added: file.added,
        removed: file.removed,
        changedAt: at,
        patches: [file.patch],
      });
      continue;
    }

    before.added += file.added;
    before.removed += file.removed;
    before.changedAt = at;
    before.patches.push(file.patch);
    // What the turn did to the file overall: one it created is still one it created,
    // however many times it has rewritten it since.
    if (before.status !== 'created' || file.status === 'deleted') before.status = file.status;
  }

  return moved;
}

/**
 * What the running turn has changed so far, in the shape the panel already draws.
 *
 * `turns` is one because this is one turn, and `diffable` is true because the diff is in
 * hand: it is what the tools reported, rather than something the store would have to be
 * read for.
 */
export function liveChanges(sessionId: string): SessionChange[] {
  const held = touched.get(sessionId);
  if (!held) return [];

  return [...held.values()].map((file) => ({
    path: file.path,
    status: file.status,
    linesAdded: file.added,
    linesRemoved: file.removed,
    turns: 1,
    changedAt: file.changedAt,
    diffable: true,
    running: true,
  }));
}

/** Every write the running turn made to one file, for the panel to draw as one diff. */
export function livePatches(sessionId: string, path: string): string[] | null {
  const file = touched.get(sessionId)?.get(path);
  return file ? file.patches : null;
}

/**
 * Forget what a session's turn was doing.
 *
 * Called when the session goes idle, which is when the CLI writes the snapshot: from that
 * moment the store is the record, and keeping this would double every count.
 */
export function forgetLive(sessionId: string): void {
  pending.delete(sessionId);
  touched.delete(sessionId);
}

/** Whether anything is being tracked, so a caller can skip the merge entirely. */
export function hasLive(sessionId: string): boolean {
  return (touched.get(sessionId)?.size ?? 0) > 0;
}
