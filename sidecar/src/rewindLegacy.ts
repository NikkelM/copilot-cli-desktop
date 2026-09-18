/**
 * The store the CLI wrote until late July 2026, read into the shape the current one has.
 *
 * Converted rather than read alongside, so everything downstream - following a file across
 * turns, narrowing to what is new, counting lines, building diffs - stays one piece of code
 * with one set of tests. The differences are all here (#185).
 *
 * The two are not a rename of each other. Measured across 153 real session directories, the
 * old store covers 2026-04-01 to 2026-07-13 and the current one 2026-08-02 onwards, with no
 * overlap at all, and what they record differs in three ways that matter:
 *
 * - **A snapshot is a whole working tree, not a turn.** Every one of 317 in a real session
 *   anchors to a `user.message` event and is stamped about half a second after it, so it is
 *   the workspace as it stood when a message arrived - before that turn ran. What a turn
 *   changed is therefore the difference between consecutive snapshots.
 * - **It records the git dirty set.** The first snapshot of that session already lists two
 *   files, `gitStatus` runs through ` M`, `??`, `A `, `M `, `MM`, `AM` and `R `, and counts
 *   drop to zero after a commit. So a file being absent means clean, not missing.
 * - **There are no per-file line counts**, only `workspaceLinesAdded` and its opposite for
 *   the whole tree. Those are left at zero here; the real numbers are recomputed from the
 *   two ends whenever the blobs are still there, which is what the current store's own
 *   totals are only a fallback for.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { legacyRewindDir, type FileChange, type Image, type RewindSnapshot } from './rewind.js';

/** The only version this understands, which the directory name has already agreed to. */
const VERSION = 1;

/** One file's state in one snapshot: a single image, where the current store keeps a pair. */
interface LegacyFile {
  gitStatus: string;
  contentHash: string;
  backupFile: string;
  size: number;
  mtime: string;
  mode: number;
}

interface LegacySnapshot {
  snapshotId: string;
  eventId: string;
  userMessage: string;
  timestamp: string;
  fileCount: number;
  files: Record<string, LegacyFile>;
  backupHashes: string[];
  /** What HEAD was. A change between two snapshots means a commit happened between them. */
  gitCommit?: string;
  workspaceLinesAdded: number;
  workspaceLinesRemoved: number;
}

interface LegacyIndex {
  version: number;
  snapshots: LegacySnapshot[];
  /** Key to absolute path. The snapshots themselves carry no paths at all. */
  filePathMap: Record<string, string>;
}

/** Whether a git status says the file did not exist before this session touched it. */
function isNew(gitStatus: string): boolean {
  const status = gitStatus.trim();
  return status.startsWith('?') || status.startsWith('A');
}

/**
 * What `git hash-object` would say about some content.
 *
 * The old store hashes with git's own scheme rather than the SHA-256 the current one uses,
 * so a file on disk can only be recognised as still holding an image by hashing it the same
 * way. The prefix is git's: the literal word, the byte length, and a NUL.
 */
export function gitBlobHash(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return `git-sha1:${createHash('sha1').update(Buffer.concat([header, content])).digest('hex')}`;
}

/** The image a recorded entry stands for. */
function imageOf(entry: LegacyFile, path: string): Image {
  return { kind: 'content', contentHash: entry.contentHash, resolvedPath: path, blob: entry.backupFile };
}

/**
 * What a file holds now, for the end of the last turn.
 *
 * The store stops at the last message, so the newest turn's results were never written
 * down - the only record of them is the working tree. Hashed here so the entry looks like
 * any other, which lets the existing fallback recognise the file on disk as its own content
 * rather than treating it as a blob that has been pruned.
 *
 * A file the last turn *created* is invisible either way: nothing lists it, because listing
 * only happens when the next message arrives and there is no next message.
 */
function diskImage(path: string): Image {
  try {
    // Large files are left alone rather than read to be hashed: the answer is only used to
    // recognise content that is still there, and a diff of something this size is refused
    // downstream anyway.
    if (statSync(path).size > 8 * 1024 * 1024) return { kind: 'skipped' };
    const now = readFileSync(path);
    return { kind: 'content', contentHash: gitBlobHash(now), resolvedPath: path };
  } catch {
    return { kind: 'absent' };
  }
}

/**
 * What a file became, when it has dropped out of the dirty set.
 *
 * Leaving the set means one of two things, and which one is answerable: a commit preserves
 * the file's contents and makes it clean, while a revert makes it clean by replacing them.
 * The snapshots record the commit they were taken at, so a commit between the two is the
 * difference between "still what the session left" and "thrown away".
 *
 * Guessing "deleted" for either would invent a deletion after every commit, which happened
 * to 38 files of 1179 in one real session.
 */
function departed(was: Image, committed: boolean, path: string): Image {
  if (committed) return was;
  return existsSync(path) ? { kind: 'skipped' } : { kind: 'absent' };
}

/**
 * What a file was before it entered the dirty set.
 *
 * A file that is merely clean is not listed, so its previous contents are whatever the
 * commit held, which this store does not keep. New files are the answerable case and the
 * common one: `??` and `A ` say it did not exist, so its previous state was nothing.
 */
function arrived(entry: LegacyFile, path: string): Image {
  if (isNew(entry.gitStatus)) return { kind: 'absent' };
  return existsSync(path) ? { kind: 'skipped' } : { kind: 'absent' };
}

/** Every turn a session recorded, oldest first, in the shape the current store uses. */
export function readLegacyRewind(sessionId: string): RewindSnapshot[] {
  let index: LegacyIndex;
  try {
    index = JSON.parse(readFileSync(join(legacyRewindDir(sessionId), 'index.json'), 'utf8')) as LegacyIndex;
  } catch {
    return [];
  }

  if (index.version !== VERSION || !Array.isArray(index.snapshots)) return [];

  const paths = index.filePathMap ?? {};
  const snapshots = [...index.snapshots].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return snapshots.map((snapshot, at) => {
    const before = snapshot.files ?? {};
    const next = snapshots[at + 1];
    // The last turn has no successor to be compared against, so the working tree stands in
    // for one. Only the files this turn started with are looked at: anything it created is
    // unknowable, having never been listed.
    const after = next?.files;

    const files: Record<string, FileChange> = {};
    const committed = next !== undefined && next.gitCommit !== snapshot.gitCommit;

    for (const key of new Set([...Object.keys(before), ...Object.keys(after ?? {})])) {
      const path = paths[key];
      if (!path) continue;

      const was = before[key];
      const now = after?.[key];

      const preimage = was ? imageOf(was, path) : arrived(now!, path);
      const postimage = after
        ? now
          ? imageOf(now, path)
          : departed(preimage, committed, path)
        : diskImage(path);

      // Sitting in the dirty set across a turn is not the same as being changed by it.
      if (preimage.kind === 'content' && postimage.kind === 'content' && preimage.contentHash === postimage.contentHash) {
        continue;
      }

      files[key] = { path, preimage, postimage, linesAdded: 0, linesRemoved: 0 };
    }

    return {
      snapshotId: snapshot.snapshotId,
      eventId: snapshot.eventId,
      userMessage: snapshot.userMessage,
      timestamp: snapshot.timestamp,
      files,
      backupFiles: snapshot.backupHashes ?? [],
      fileCount: Object.keys(files).length,
      linesAdded: 0,
      linesRemoved: 0,
    };
  });
}
