import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sessionStateDir } from './paths.js';
import { readLegacyRewind } from './rewindLegacy.js';

/**
 * The Copilot CLI's own record of what each turn changed, read.
 *
 * The runtime keeps this per session and reads it to offer a rewind. It is written by the
 * runtime's native code, not by this app: #142 is the account of what happened when both
 * wrote to it, which was that one silently replaced the other's work.
 *
 * Reading it is what makes the changes panel possible without a git repository and without
 * a Copilot process: it is the agent's own record of its own work, so edits someone made in
 * an editor alongside it were never in it to exclude. Everything below was verified against
 * a real store of 107 snapshots and 671 file entries rather than inferred from one example -
 * see #125 for the evidence.
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
      encodedPath?: { encoding: 'windows-wide'; data: string };
      /**
       * The blob's filename, when the store names it something other than its hash.
       *
       * The older store addresses backups as `<16 hex>-<epoch ms>`, so the hash alone does
       * not find them. Absent means the hash is the name, which is how the current one works.
       */
      blob?: string;
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
const backupPath = (sessionId: string, hash: string) => join(rewindDir(sessionId), 'backups', hash);

/** Where the store the CLI wrote until late July lives, alongside rather than instead. */
export const legacyRewindDir = (sessionId: string) => join(sessionStateDir(sessionId), 'rewind-snapshots');

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
 * Every turn recorded for a session, oldest first.
 *
 * A schema this does not know is treated as no history rather than as something to parse
 * optimistically: reading it wrong would be worse than not reading it.
 *
 * Two stores have existed. The one read here is what the CLI has written since early
 * August; sessions from April to mid-July have `rewind-snapshots` instead, which records
 * something different enough to need its own reader (#185). Chosen by which directory is
 * there rather than by the version inside, because both say `1` and mean different things.
 */
export function readRewind(sessionId: string): RewindSnapshot[] {
  if (!existsSync(indexPath(sessionId)) && existsSync(legacyRewindDir(sessionId))) {
    return readLegacyRewind(sessionId);
  }

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
export function readBackup(sessionId: string, hash: string, blob?: string): Buffer | null {
  // The older store names blobs `<16 hex>-<epoch ms>` and keeps them somewhere else, so
  // the name it gave is followed rather than the hash, which would find nothing.
  const path = blob ? join(legacyRewindDir(sessionId), 'backups', blob) : backupPath(sessionId, hash);
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
