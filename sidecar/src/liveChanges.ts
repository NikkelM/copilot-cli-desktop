import { diffLines } from 'diff';

import type { SessionChange } from '../../shared/protocol.js';

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
 * can help is the event stream, which already says which file each tool is about and what
 * it is writing. This keeps that, per session, until the snapshot takes over.
 *
 * Held in the sidecar rather than in the app because the sidecar sees every session's
 * events all the time. The app only has the session on screen, and only the pages of it
 * that have been read, so a turn running in a session somebody navigated away from would
 * lose its changes to the gap.
 */

/** The tools that write files, as the logs here actually name them. */
const WRITES: ReadonlySet<string> = new Set(['edit', 'create', 'apply_patch']);

/** One file a running turn has touched, as the tool that touched it described the change. */
interface LiveFile {
  path: string;
  status: SessionChange['status'];
  linesAdded: number;
  linesRemoved: number;
  changedAt: string;
}

/** A call that has started and not yet finished, so its work is not counted yet. */
interface Pending {
  toolName: string;
  arguments: unknown;
}

/** Per session: the calls in flight, and what the finished ones have done. */
const pending = new Map<string, Map<string, Pending>>();
const touched = new Map<string, Map<string, LiveFile>>();

/**
 * Take note of a tool starting.
 *
 * Held rather than counted: a tool that fails changes nothing, and counting at the start
 * would show work that never happened and then have to take it back.
 */
export function noteToolStart(sessionId: string, toolCallId: string, toolName: string, args: unknown): void {
  if (!WRITES.has(toolName)) return;

  let calls = pending.get(sessionId);
  if (!calls) pending.set(sessionId, (calls = new Map()));
  calls.set(toolCallId, { toolName, arguments: args });
}

/**
 * Take note of it finishing, and say whether the answer moved.
 *
 * The caller uses that to decide whether to tell anybody. A tool that wrote nothing, failed,
 * or was never a file tool is not worth a notification.
 */
export function noteToolEnd(sessionId: string, toolCallId: string, success: boolean, at: string): boolean {
  const calls = pending.get(sessionId);
  const call = calls?.get(toolCallId);
  if (!call) return false;

  calls!.delete(toolCallId);
  if (calls!.size === 0) pending.delete(sessionId);
  // A failed write left the file as it was, whatever it meant to do.
  if (!success) return false;

  const files = describe(call.toolName, call.arguments, at);
  if (files.length === 0) return false;

  let held = touched.get(sessionId);
  if (!held) touched.set(sessionId, (held = new Map()));

  for (const file of files) {
    const before = held.get(file.path);
    if (!before) {
      held.set(file.path, file);
      continue;
    }

    // Touched twice in the same turn. The counts add up, and the status is the one that
    // says what the turn did to the file overall: created then edited is still created.
    before.linesAdded += file.linesAdded;
    before.linesRemoved += file.linesRemoved;
    before.changedAt = file.changedAt;
    if (before.status !== 'created' || file.status === 'deleted') before.status = file.status;
  }

  return true;
}

/**
 * What the running turn has changed so far, in the shape the panel already draws.
 *
 * `turns` is one because this is one turn, and `diffable` is false because there is no
 * snapshot to diff against yet: the before image lives in the CLI's store and is not named
 * until the turn ends. The row says what changed and how much; the diff follows.
 */
export function liveChanges(sessionId: string): SessionChange[] {
  const held = touched.get(sessionId);
  if (!held) return [];

  return [...held.values()].map((file) => ({
    path: file.path,
    status: file.status,
    linesAdded: file.linesAdded,
    linesRemoved: file.linesRemoved,
    turns: 1,
    changedAt: file.changedAt,
    diffable: false,
    running: true,
  }));
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

/**
 * What a call did, read from the arguments it was given.
 *
 * The arguments carry the content, so nothing has to be read from disk: an edit has both
 * strings, a create has the whole file, and a patch has its own hunks. Counting here is
 * also the only way to count at all, since the file on disk has already been written by the
 * time this is asked and its previous contents are gone.
 */
function describe(toolName: string, args: unknown, at: string): LiveFile[] {
  if (toolName === 'apply_patch') return typeof args === 'string' ? fromPatch(args, at) : [];
  if (typeof args !== 'object' || args === null) return [];

  const data = args as Record<string, unknown>;
  const path = typeof data.path === 'string' ? data.path : null;
  // A malformed call with no path at all, which the logs here do contain: 46 of 23,820
  // edits. Nothing can be attributed to a file nobody named.
  if (!path) return [];

  if (toolName === 'create') {
    const text = typeof data.file_text === 'string' ? data.file_text : '';
    return [{ path, status: 'created', linesAdded: lines(text), linesRemoved: 0, changedAt: at }];
  }

  const before = typeof data.old_str === 'string' ? data.old_str : '';
  const after = typeof data.new_str === 'string' ? data.new_str : '';
  const { added, removed } = countEdit(before, after);
  // A replacement that moved no lines left the file as it was. The store skips those too,
  // comparing the two ends of a file rather than trusting that a tool ran.
  if (added === 0 && removed === 0) return [];

  return [{ path, status: 'modified', linesAdded: added, linesRemoved: removed, changedAt: at }];
}

/**
 * Lines a replacement added and removed, through the same differ the panel uses.
 *
 * Not the line counts of the two strings: replacing one line of twenty with another is one
 * added and one removed, where the lengths would say twenty of each.
 */
function countEdit(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const part of diffLines(before, after)) {
    const count = part.count ?? lines(part.value);
    if (part.added) added += count;
    else if (part.removed) removed += count;
  }

  return { added, removed };
}

/**
 * The files a patch envelope names, and what it does to each.
 *
 * The envelope is the CLI's own format rather than a unified diff: `*** Update File:` and
 * its siblings, with the hunks between them. Measured here, 2,144 updates, 89 additions and
 * 14 deletions across 1,242 calls, and a single call may name several files.
 */
function fromPatch(patch: string, at: string): LiveFile[] {
  const files: LiveFile[] = [];
  let current: LiveFile | null = null;

  for (const line of patch.split('\n')) {
    const directive = /^\*\*\* (Update File|Add File|Delete File|Move to): (.+)$/.exec(line);
    if (directive) {
      const [, what, named] = directive;
      const path = named!.trim();

      // A move names where the file went, which is the same change seen from the other end
      // rather than a file of its own.
      if (what === 'Move to') {
        if (current) current.path = path;
        continue;
      }

      current = {
        path,
        status: what === 'Add File' ? 'created' : what === 'Delete File' ? 'deleted' : 'modified',
        linesAdded: 0,
        linesRemoved: 0,
        changedAt: at,
      };
      files.push(current);
      continue;
    }

    if (!current) continue;
    // The envelope's own markers start with three stars, so they cannot be mistaken for a
    // removed line beginning with one.
    if (line.startsWith('***')) continue;
    if (line.startsWith('+')) current.linesAdded += 1;
    else if (line.startsWith('-')) current.linesRemoved += 1;
  }

  return files;
}

/** How many lines a piece of text is, counting a trailing newline as ending the last one. */
function lines(text: string): number {
  if (!text) return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').length;
}
