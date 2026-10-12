import { splitByFile, WRITE_TOOLS, type PatchStatus } from '../../shared/patch';
import type { FileDiff, SessionChange, TranscriptEvent } from '../../shared/protocol';

/**
 * What one delegated run changed, from its own account of it (#261).
 *
 * The rewind store the session's changes come from cannot answer this. Its snapshots carry
 * no agent and are taken a turn at a time, and a run happens inside a turn of the session
 * that delegated it, so one snapshot holds the session's edits and every run's together.
 * Asking it which were whose gets a guess: of 912 files a run wrote on this machine, 74%
 * were also written by somebody else somewhere in the same session.
 *
 * The run's own tool calls do answer it. Every successful write reports the unified diff it
 * applied, so a run's changes are exactly the diffs its own calls reported - attribution by
 * construction rather than by inference, with nothing to caveat.
 *
 * Read from the events already on screen rather than asked of the sidecar. The view holds
 * the run's whole transcript to draw it, and those diffs are in it, so a second reading of
 * the same log would buy nothing. It also means the answer is in hand the moment the view
 * opens, which is what lets the button appear only where there is something behind it.
 */

/** One file a run wrote, as the tools that wrote it reported. */
interface AgentFile {
  status: PatchStatus;
  added: number;
  removed: number;
  changedAt: string;
  /** How many of its writes landed here, which is what the row counts instead of turns. */
  writes: number;
  /**
   * Each write in the order it was made.
   *
   * Kept apart rather than joined: the second write's line numbers count a file the first
   * already changed. The panel joins them for drawing with the code it already uses for the
   * writes of a running turn, so the two cannot disagree.
   */
  patches: string[];
}

/**
 * The files a run wrote, by path.
 *
 * Paired by tool call id rather than read from the completion alone, because a completion
 * does not say which tool it belongs to - only the start does. The diff is then read for
 * the paths rather than the start's arguments, which is both simpler and the only thing
 * that works for all three: `edit` and `create` name their file in an argument, while
 * `apply_patch` is handed one string and names its files inside it.
 */
function filesWrittenBy(events: readonly TranscriptEvent[]): Map<string, AgentFile> {
  const writing = new Set<string>();
  const files = new Map<string, AgentFile>();

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const call = typeof data.toolCallId === 'string' ? data.toolCallId : null;
    if (!call) continue;

    if (event.type === 'tool.execution_start') {
      if (typeof data.toolName === 'string' && WRITE_TOOLS.has(data.toolName)) writing.add(call);
      continue;
    }

    if (event.type !== 'tool.execution_complete' || !writing.delete(call)) continue;

    // A failed write left the file as it was, whatever it meant to do, and reports no diff.
    const reported = (data.result as { detailedContent?: unknown } | undefined)?.detailedContent;
    if (data.success !== true || typeof reported !== 'string' || !reported) continue;

    const at = String(event.timestamp ?? '');

    for (const file of splitByFile(reported)) {
      // Writing a file without changing it reports a patch of nothing but context. Counting
      // it would claim a change that is not there.
      if (file.added === 0 && file.removed === 0) continue;

      // Left spelled as the patch spells it, with forward slashes. Nothing here is matched
      // against a path from anywhere else, and the panel folds separators before it shortens
      // one against the working directory.
      const path = file.path;
      const before = files.get(path);

      if (!before) {
        files.set(path, {
          status: file.status,
          added: file.added,
          removed: file.removed,
          changedAt: at,
          writes: 1,
          patches: [file.patch],
        });
        continue;
      }

      before.added += file.added;
      before.removed += file.removed;
      before.changedAt = at;
      before.writes += 1;
      before.patches.push(file.patch);
      // What the run did to the file overall: one it created is still one it created,
      // however many times it rewrote it afterwards.
      if (before.status !== 'created' || file.status === 'deleted') before.status = file.status;
    }
  }

  return files;
}

/**
 * Every file a run changed with the diffs for each, most recently touched first.
 *
 * The diffs come back with the list rather than on request, because there is nothing to
 * request: they are already here, in the events this was read from.
 *
 * `diffable` is always true, and `stale` always false. The patch is what the run reported
 * doing rather than a comparison against the file as it stands, so there is no version of
 * it to go looking for and nothing anybody has done since can make it describe something
 * else.
 */
export function agentChanges(events: readonly TranscriptEvent[]): {
  changes: SessionChange[];
  diffs: Record<string, FileDiff>;
} {
  const files = filesWrittenBy(events);

  const changes = [...files.entries()]
    .map(([path, file]) => ({
      path,
      status: file.status,
      linesAdded: file.added,
      linesRemoved: file.removed,
      turns: file.writes,
      changedAt: file.changedAt,
      diffable: true,
    }))
    .sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.path.localeCompare(b.path));

  const diffs = Object.fromEntries(
    [...files.entries()].map(([path, file]) => [path, { patch: null, patches: file.patches, stale: false }]),
  );

  return { changes, diffs };
}
