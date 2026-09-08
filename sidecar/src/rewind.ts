import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { sessionStateDir } from './paths.js';

/**
 * The Copilot CLI's own record of what each turn changed.
 *
 * The CLI keeps this per session, and reads it to offer a rewind. This app used to keep a
 * parallel git-based record instead, which meant the two could not see each other's work:
 * a turn run in the CLI was invisible here and vice versa, and a session outside a git
 * repository got nothing from this app at all.
 *
 * So this reads and writes the CLI's format, in the CLI's directory. Everything below was
 * verified against a real store of 107 snapshots and 671 file entries rather than inferred
 * from one example - see #125 for the evidence.
 *
 * Writing into a directory another program owns is a real hazard, so the rules are strict:
 * the schema is checked rather than assumed, a session the CLI has turned tracking off for
 * is left alone, and the index is written beside and moved into place so a crash cannot
 * leave a half-written file the CLI then fails to parse.
 */

/** The only schema this understands. A later one is not ours to guess at. */
const SCHEMA = 1;

/** What a file looked like at one end of a turn. */
export type Image =
  | { kind: 'absent' }
  | { kind: 'skipped' }
  | {
      kind: 'content';
      contentHash: string;
      resolvedPath: string;
      encodedPath: { encoding: 'windows-wide'; data: string };
    };

export interface FileChange {
  path: string;
  preimage: Image;
  postimage: Image;
  linesAdded: number;
  linesRemoved: number;
}

export interface RewindSnapshot {
  snapshotId: string;
  eventId: string;
  userMessage: string;
  timestamp: string;
  files: Record<string, FileChange>;
  backupFiles: string[];
  fileCount: number;
  linesAdded: number;
  linesRemoved: number;
}

interface RewindIndex {
  schema: number;
  snapshots: RewindSnapshot[];
}

const rewindDir = (sessionId: string) => join(sessionStateDir(sessionId), 'rewind-file-snapshots');
const indexPath = (sessionId: string) => join(rewindDir(sessionId), 'index.json');
const trackingPath = (sessionId: string) => join(rewindDir(sessionId), 'tracking.json');
const backupPath = (sessionId: string, hash: string) => join(rewindDir(sessionId), 'backups', hash);

/**
 * The key a file is filed under: the first half of the SHA-256 of its display path.
 *
 * Checked against all 671 entries of a real store, and stable for a given path across every
 * snapshot in it, so a file can be followed through a session's history by this alone.
 */
export function fileKey(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 32);
}

/** The name a blob is stored under, which is also how its contents are addressed. */
export function contentHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The `\\?\` form Windows uses for extended-length paths.
 *
 * The CLI records this alongside the display path. Note this is the form that Node's module
 * resolver chokes on, so it is written here deliberately and never handed back to Node.
 */
export function verbatimPath(path: string): string {
  if (process.platform !== 'win32' || !isAbsolute(path) || path.startsWith('\\\\?\\')) return path;
  return `\\\\?\\${path}`;
}

/**
 * The path again, as UTF-16 **big-endian** hex.
 *
 * Big-endian is not what the little-endian Windows convention would suggest, so it is worth
 * stating plainly: 1092 of 1092 entries in a real store match big-endian and none match
 * little-endian. Presumably so a path that is not valid UTF-8 still round-trips.
 */
export function encodePath(resolvedPath: string): { encoding: 'windows-wide'; data: string } {
  const bytes = Buffer.from(resolvedPath, 'utf16le');
  bytes.swap16();
  return { encoding: 'windows-wide', data: bytes.toString('hex') };
}

/** Describe a file that exists, storing its contents where the CLI expects to find them. */
export function imageOf(sessionId: string, path: string, content: Buffer): Image {
  const hash = contentHash(content);
  const resolvedPath = verbatimPath(path);

  const blob = backupPath(sessionId, hash);
  if (!existsSync(blob)) {
    mkdirSync(join(rewindDir(sessionId), 'backups'), { recursive: true });
    writeFileSync(blob, content);
  }

  return { kind: 'content', contentHash: hash, resolvedPath, encodedPath: encodePath(resolvedPath) };
}

/**
 * Whether this session is being tracked.
 *
 * The CLI writes this, and a reader who turned rewind off should not have it turned back on
 * by another program. Absent means nothing has tracked this session yet, which is not the
 * same as being switched off.
 */
export function isTracking(sessionId: string): boolean {
  try {
    const file = JSON.parse(readFileSync(trackingPath(sessionId), 'utf8')) as {
      schema?: number;
      tracking?: boolean;
    };
    if (file.schema !== SCHEMA) return false;
    return file.tracking !== false;
  } catch {
    return true; // No file yet: nothing has said not to.
  }
}

/** Say that this session is tracked, for a session the CLI has not yet written to. */
function startTracking(sessionId: string): void {
  if (existsSync(trackingPath(sessionId))) return;
  mkdirSync(rewindDir(sessionId), { recursive: true });
  writeFileSync(trackingPath(sessionId), `${JSON.stringify({ schema: SCHEMA, tracking: true })}\n`);
}

/**
 * Every turn recorded for a session, oldest first.
 *
 * A schema this does not know is treated as no history rather than as something to parse
 * optimistically: reading it wrong would be worse than not reading it.
 */
export function readRewind(sessionId: string): RewindSnapshot[] {
  try {
    const file = JSON.parse(readFileSync(indexPath(sessionId), 'utf8')) as RewindIndex;
    if (file.schema !== SCHEMA || !Array.isArray(file.snapshots)) return [];
    return file.snapshots;
  } catch {
    return [];
  }
}

/**
 * The contents a file had, or null when the backup has since been pruned.
 *
 * Pruning is normal: 254 of 1092 blobs referenced by a real store no longer existed. A
 * caller must treat a missing one as history it cannot show rather than as corruption.
 */
export function readBackup(sessionId: string, hash: string): Buffer | null {
  try {
    return readFileSync(backupPath(sessionId, hash));
  } catch {
    return null;
  }
}

/**
 * Add a turn to the record.
 *
 * Written beside and moved into place, because the CLI reads this file and a half-written
 * one would leave it unable to offer a rewind at all.
 */
export function appendRewind(sessionId: string, snapshot: RewindSnapshot): boolean {
  if (!isTracking(sessionId)) return false;

  startTracking(sessionId);
  const snapshots = [...readRewind(sessionId), snapshot];
  const index: RewindIndex = { schema: SCHEMA, snapshots };

  const staging = `${indexPath(sessionId)}.tmp`;
  writeFileSync(staging, JSON.stringify(index));
  renameSync(staging, indexPath(sessionId));
  return true;
}

/** Totals the CLI keeps on each snapshot, so a reader need not add them up itself. */
export function summarise(files: Record<string, FileChange>): Pick<
  RewindSnapshot,
  'fileCount' | 'linesAdded' | 'linesRemoved' | 'backupFiles'
> {
  const changes = Object.values(files);
  const hashes = new Set<string>();
  for (const change of changes) {
    for (const image of [change.preimage, change.postimage]) {
      if (image.kind === 'content') hashes.add(image.contentHash);
    }
  }

  return {
    fileCount: changes.length,
    linesAdded: changes.reduce((n, c) => n + c.linesAdded, 0),
    linesRemoved: changes.reduce((n, c) => n + c.linesRemoved, 0),
    backupFiles: [...hashes],
  };
}

/** How many lines were added and removed between two versions of a file. */
export function countLines(before: Buffer | null, after: Buffer | null): {
  linesAdded: number;
  linesRemoved: number;
} {
  const lines = (content: Buffer | null) => (content ? content.toString('utf8').split('\n') : []);
  const from = lines(before);
  const to = lines(after);

  // Line counts, not a diff: the CLI records totals rather than hunks, and computing a real
  // edit script for every file of every turn would cost more than the number is worth. The
  // shared prefix and suffix are excluded so an edit in the middle of a file does not read
  // as the whole file being rewritten.
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;

  let tail = 0;
  while (
    tail < from.length - head &&
    tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) {
    tail++;
  }

  return { linesAdded: to.length - head - tail, linesRemoved: from.length - head - tail };
}

/** Blobs on disk for a session, so a caller can tell pruning from corruption. */
export function backupCount(sessionId: string): number {
  try {
    return readdirSync(join(rewindDir(sessionId), 'backups')).length;
  } catch {
    return 0;
  }
}
