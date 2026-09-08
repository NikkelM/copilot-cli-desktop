import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createTwoFilesPatch, diffLines } from 'diff';

import type { FileDiff, SessionChange } from '../../shared/protocol.js';
import { contentHash, fileKey, readBackup, readRewind, type Image, type RewindSnapshot } from './rewind.js';

/**
 * What a session changed, answered from the rewind store rather than from git.
 *
 * The store holds every turn's before and after for every file a tool named, so the answer
 * is the agent's own work and nothing else: edits someone made in an editor alongside it
 * never entered it. That is the distinction a git diff cannot draw, and the reason #125
 * replaced the git snapshots with this.
 *
 * Reading costs no Copilot process. A session that has not been opened since the app
 * started can still say what it did, which is the same bargain the sidebar makes.
 */

/** Where a file stood at each end of the session, and what the turns in between recorded. */
interface Ends {
  path: string;
  first: Image;
  last: Image;
  turns: number;
  changedAt: string;
  /** Per-turn totals, summed. Only used when the blobs to compute a real answer are gone. */
  added: number;
  removed: number;
}

/**
 * Follow each file from the first turn that touched it to the last.
 *
 * Keyed by the store's own key rather than by path, which is what makes a file followable:
 * the key is a hash of the path and is stable across every snapshot in a session.
 *
 * `since` narrows the span to the turns after a moment, which is what makes "and what has
 * happened since I last looked" the same question as "what did this session change" rather
 * than a second one. Narrowing here rather than filtering the answer afterwards is what
 * makes it honest: the preimage becomes the file as it stood at that moment, so the diff is
 * the work done since and not the work of the whole session with the old rows hidden.
 */
function follow(snapshots: RewindSnapshot[], since?: string): Map<string, Ends> {
  const ends = new Map<string, Ends>();

  for (const snapshot of snapshots) {
    if (!after(snapshot.timestamp, since)) continue;

    for (const [key, change] of Object.entries(snapshot.files ?? {})) {
      const seen = ends.get(key);
      if (!seen) {
        ends.set(key, {
          path: change.path,
          first: change.preimage,
          last: change.postimage,
          turns: 1,
          changedAt: snapshot.timestamp,
          added: change.linesAdded,
          removed: change.linesRemoved,
        });
        continue;
      }

      // The first preimage stays: what the file was before this session is what it was
      // before the earliest turn that touched it, not before the most recent one.
      seen.last = change.postimage;
      seen.turns += 1;
      seen.changedAt = snapshot.timestamp;
      seen.added += change.linesAdded;
      seen.removed += change.linesRemoved;
    }
  }

  return ends;
}

/**
 * Whether a snapshot falls after a moment, erring towards showing it.
 *
 * A timestamp neither side can read is shown rather than hidden. Hiding is the answer that
 * loses work silently, and a mark that cannot be compared is a bug in the mark, not a
 * reason to tell someone their session changed nothing.
 */
function after(timestamp: string, since?: string): boolean {
  if (!since) return true;

  const at = Date.parse(timestamp);
  const mark = Date.parse(since);
  if (Number.isNaN(at) || Number.isNaN(mark)) return true;
  return at > mark;
}

/**
 * Files nobody means when they ask what a session changed.
 *
 * A pasted image, a downloaded attachment and a scratch file the runtime wrote all land in
 * the temporary directory, and all get snapshotted like anything else. They are noise in
 * the answer: nobody reviews `u2.png` in `AppData\Local\Temp`, and the CLI has usually
 * deleted them by the time anyone looks, so the row cannot even offer a diff.
 *
 * The unix roots are listed alongside the platform's own because a temporary directory is
 * only one of several by convention, and this is cheap enough to be generous about.
 * `tmpdir()` is read per call rather than held, so it follows the environment.
 */
const TEMP_ROOTS = ['/tmp', '/var/tmp', '/var/folders', '/private/var/folders'];

function transient(path: string): boolean {
  const normalised = path.replace(/\\/g, '/').toLowerCase();

  return [tmpdir(), ...TEMP_ROOTS].some((root) => {
    const prefix = root.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    return normalised.startsWith(`${prefix}/`);
  });
}

/**
 * The contents an end of a change stands for, or null when they cannot be produced.
 *
 * The store is not self-contained. The CLI leaves out the backing blob when the content is
 * still what the file holds on disk - the most recent postimage of a file nobody has touched
 * since, which is the common case - and reads the file instead. Without that fallback almost
 * nothing is diffable: 254 of 276 files in a real session, where the actual pruning rate is
 * one blob in seventy-nine.
 *
 * The hash is checked before the file is believed, so a file edited since falls through to
 * "gone" rather than being passed off as what the session left.
 */
function contentsOf(sessionId: string, image: Image, path: string): Buffer | null {
  if (image.kind === 'absent') return Buffer.alloc(0);
  if (image.kind === 'skipped') return null;

  const blob = readBackup(sessionId, image.contentHash);
  if (blob) return blob;

  try {
    const now = readFileSync(path);
    return contentHash(now) === image.contentHash ? now : null;
  } catch {
    return null;
  }
}

/** Whether the two ends describe the same file, so nothing was actually left changed. */
function unchanged(first: Image, last: Image): boolean {
  if (first.kind === 'absent' && last.kind === 'absent') return true;
  if (first.kind !== 'content' || last.kind !== 'content') return false;
  return first.contentHash === last.contentHash;
}

function statusOf(first: Image, last: Image): SessionChange['status'] {
  if (first.kind === 'absent') return 'created';
  if (last.kind === 'absent') return 'deleted';
  return 'modified';
}

/**
 * Lines added and removed across the whole session, not turn by turn.
 *
 * Summing what each turn recorded double-counts a line the agent wrote and then rewrote,
 * so the totals are recomputed from the two ends whenever both are still readable. When a
 * blob has been pruned the sum is all there is, and the caller is told the difference
 * through `diffable` rather than being handed a number that quietly means something else.
 *
 * A created or deleted file is counted by counting its lines: there is nothing to compare
 * it against, and that is most of the files in a session. Only the ones that were genuinely
 * edited pay for a real comparison, and none of them pay for a patch to be built and then
 * read back, which is what took this from half a second to nearly four.
 */
function count(sessionId: string, ends: Ends): { linesAdded: number; linesRemoved: number; diffable: boolean } {
  const before = contentsOf(sessionId, ends.first, ends.path);
  const after = contentsOf(sessionId, ends.last, ends.path);
  if (!before || !after) return { linesAdded: ends.added, linesRemoved: ends.removed, diffable: false };

  if (binary(before) || binary(after)) {
    return { linesAdded: ends.added, linesRemoved: ends.removed, diffable: false };
  }

  if (ends.first.kind === 'absent') return { linesAdded: lineCount(after), linesRemoved: 0, diffable: true };
  if (ends.last.kind === 'absent') return { linesAdded: 0, linesRemoved: lineCount(before), diffable: true };

  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of diffLines(before.toString('utf8'), after.toString('utf8'))) {
    if (part.added) linesAdded += part.count ?? 0;
    else if (part.removed) linesRemoved += part.count ?? 0;
  }

  return { linesAdded, linesRemoved, diffable: true };
}

/** Lines in a buffer, where a trailing newline ends the last line rather than starting one. */
function lineCount(content: Buffer): number {
  if (content.length === 0) return 0;

  let newlines = 0;
  for (const byte of content) if (byte === 10) newlines += 1;
  return content[content.length - 1] === 10 ? newlines : newlines + 1;
}

/**
 * A NUL byte early on, which is the test every diff tool uses and is right often enough.
 *
 * A patch of a binary file is noise at best, and at worst megabytes of it sent over the
 * wire to be drawn as text.
 */
function binary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/** A unified diff between two versions of one file, or null when there is no drawing it. */
function diffOf(path: string, before: Buffer, after: Buffer): string | null {
  if (binary(before) || binary(after)) return null;
  return createTwoFilesPatch(path, path, before.toString('utf8'), after.toString('utf8'), undefined, undefined, {
    context: CONTEXT,
  });
}

/** Unchanged lines kept either side of a change. The viewer collapses longer runs itself. */
const CONTEXT = 4;

/**
 * Every file this session left changed, most recently touched first.
 *
 * Files the session created and then deleted, or edited back to what they were, are left
 * out: the question is what the session changed, and the answer for those is nothing.
 *
 * With `since`, only the turns after that moment are read, so the answer is what has
 * happened since someone last reviewed it rather than everything again.
 */
export function sessionChanges(sessionId: string, since?: string): SessionChange[] {
  const changes: SessionChange[] = [];

  for (const ends of follow(readRewind(sessionId), since).values()) {
    if (unchanged(ends.first, ends.last)) continue;
    if (transient(ends.path)) continue;

    changes.push({
      path: ends.path,
      status: statusOf(ends.first, ends.last),
      turns: ends.turns,
      changedAt: ends.changedAt,
      ...count(sessionId, ends),
    });
  }

  return changes.sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.path.localeCompare(b.path));
}

/**
 * The diff for one of those files.
 *
 * Also says whether the file on disk still matches what the session left, because it often
 * will not - the user edits the same files - and a diff that silently stood for someone
 * else's work as well would be worse than no diff at all.
 *
 * `since` has to match the one the list was built with, or the row and the diff under it
 * would be answering different questions.
 */
export function sessionDiff(sessionId: string, path: string, since?: string): FileDiff {
  const ends = follow(readRewind(sessionId), since).get(fileKey(path));
  if (!ends) return { patch: null, reason: 'untracked', stale: false };

  const before = contentsOf(sessionId, ends.first, ends.path);
  const after = contentsOf(sessionId, ends.last, ends.path);
  if (!before || !after) return { patch: null, reason: 'pruned', stale: false };

  const patch = diffOf(ends.path, before, after);
  if (!patch) return { patch: null, reason: 'binary', stale: false };

  return { patch, stale: !matchesDisk(ends.last, path) };
}

/** Whether the file is still what the session left behind, or has been changed since. */
function matchesDisk(last: Image, path: string): boolean {
  try {
    const now = readFileSync(path);
    if (last.kind === 'absent') return false; // Deleted by the session, back on disk since.
    if (last.kind === 'skipped') return true; // Nothing was recorded to disagree with.
    return contentHash(now) === last.contentHash;
  } catch {
    // Not there now. That matches only if the session was the one that removed it.
    return last.kind === 'absent';
  }
}
