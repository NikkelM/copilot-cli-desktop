import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  appendRewind,
  countLines,
  fileKey,
  imageOf,
  isTracking,
  summarise,
  type FileChange,
  type Image,
  type RewindSnapshot,
} from './rewind.js';

/**
 * Watch a turn and record what it changed, in the CLI's own rewind format.
 *
 * The CLI records this for turns it runs; a turn driven through the SDK produces nothing,
 * which is why this exists. Both write the same files in the same place, so a session can be
 * worked on in either and the other still sees the history.
 *
 * A file's before is read when the tool that will change it starts, and its after when that
 * tool finishes. Reading the whole workspace at each end of a turn would be the alternative,
 * and is what the git mechanism this replaces did - it needed a repository to be affordable,
 * which is exactly the limitation being removed.
 *
 * **Known gap:** only the tools that name the file they change are captured. A shell command
 * can write anywhere and says nothing about it, and shell is the most used tool by a wide
 * margin, so a turn that edits through the shell records nothing. Closing that needs either a
 * watcher or a whole-tree comparison, and is worth doing separately.
 */

/** Tools that change a file and say which one in their arguments. */
const FILE_TOOLS = new Set(['create', 'edit', 'str_replace', 'write', 'insert']);

/** What a turn has changed so far, and what those files looked like before it started. */
export interface TurnCapture {
  eventId: string;
  userMessage: string;
  startedAt: string;
  /** By path: what the file was when the turn first touched it, and what it is now. */
  files: Map<string, { before: Buffer | null; after: Buffer | null }>;
  /** Tool calls in flight, so a completion can be matched to the path it started with. */
  pending: Map<string, string>;
}

export function beginTurn(eventId: string, userMessage: string): TurnCapture {
  return {
    eventId,
    userMessage,
    startedAt: new Date().toISOString(),
    files: new Map(),
    pending: new Map(),
  };
}

/** The file a tool call is about, when it is a tool that changes one. */
export function pathOf(toolName: string | undefined, args: unknown): string | null {
  if (!toolName || !FILE_TOOLS.has(toolName)) return null;

  const path = (args as { path?: unknown })?.path;
  return typeof path === 'string' && path.trim() !== '' ? path : null;
}

const contentsOf = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null; // Absent, or unreadable, which for this purpose is the same thing.
  }
};

/** A tool that will change a file is starting: remember what the file is now. */
export function noteToolStart(capture: TurnCapture, callId: string, path: string): void {
  capture.pending.set(callId, path);

  // Only the first time in a turn. A file edited twice was, before the turn, whatever it
  // was before the first edit - not what the first edit left behind.
  if (!capture.files.has(path)) capture.files.set(path, { before: contentsOf(path), after: null });
}

/** That tool has finished: the file is now whatever it left behind. */
export function noteToolEnd(capture: TurnCapture, callId: string): void {
  const path = capture.pending.get(callId);
  if (!path) return;
  capture.pending.delete(callId);

  const seen = capture.files.get(path);
  if (seen) seen.after = contentsOf(path);
}

/**
 * Write the turn down, or decide there is nothing worth writing.
 *
 * Returns whether a snapshot was recorded, so a caller can tell "nothing changed" from
 * "tracking is off" if it cares.
 */
export function endTurn(sessionId: string, capture: TurnCapture): boolean {
  const files: Record<string, FileChange> = {};

  for (const [path, { before, after }] of capture.files) {
    // Unchanged files are not a change. A tool that reported success without altering
    // anything - an edit whose replacement matched what was there - should leave no trace.
    if (before && after && before.equals(after)) continue;
    if (!before && !after) continue;

    const preimage: Image = before ? imageOf(sessionId, path, before) : { kind: 'absent' };
    const postimage: Image = after ? imageOf(sessionId, path, after) : { kind: 'absent' };

    files[fileKey(path)] = { path, preimage, postimage, ...countLines(before, after) };
  }

  if (Object.keys(files).length === 0) return false;

  const snapshot: RewindSnapshot = {
    snapshotId: randomUUID(),
    eventId: capture.eventId,
    userMessage: capture.userMessage,
    timestamp: capture.startedAt,
    files,
    ...summarise(files),
  };

  return appendRewind(sessionId, snapshot);
}

/** Whether recording is worth starting at all for this session. */
export const shouldRecord = (sessionId: string): boolean => isTracking(sessionId);
