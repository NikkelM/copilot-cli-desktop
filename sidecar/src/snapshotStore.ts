import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sessionStateDir } from './paths.js';
import type { Snapshot } from './snapshots.js';

/** One point a session can be looked at, or put back to. */
export interface SnapshotRecord extends Snapshot {
  /** Identifies the point: `baseline`, or the turn it was taken for. */
  id: string;
  /** What the turn was asked to do, so a point can be named rather than numbered. */
  prompt?: string;
}

interface SnapshotFile {
  version: 1;
  /** The repository the commits belong to; a session may be reopened elsewhere. */
  root: string;
  snapshots: SnapshotRecord[];
}

const VERSION = 1;
const FILE = 'desktop-snapshots.json';

/**
 * Snapshots kept for one session, on disk beside the session's own state.
 *
 * The whole record is a commit id and a timestamp, so this is kilobytes where the CLI's
 * equivalent runs to tens of megabytes: git already holds the content, and the ref taken
 * with each snapshot is what keeps it. Being on disk is what lets a diff outlive both the
 * eviction of an idle session and a restart of the app.
 */
export function readSnapshots(sessionId: string): SnapshotFile | null {
  const path = join(sessionStateDir(sessionId), FILE);
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SnapshotFile;
    // A file from a future version is not ours to guess at, and a session recorded against
    // a different repository says nothing about this one.
    return parsed.version === VERSION && Array.isArray(parsed.snapshots) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSnapshots(sessionId: string, file: SnapshotFile): void {
  const dir = sessionStateDir(sessionId);
  const path = join(dir, FILE);

  try {
    mkdirSync(dir, { recursive: true });
    // Written beside and moved into place, so a crash midway leaves the previous file
    // rather than half of this one.
    const staging = `${path}.${process.pid}.tmp`;
    writeFileSync(staging, JSON.stringify(file, null, 2));
    renameSync(staging, path);
  } catch {
    // Losing the record costs a diff, which is not worth failing a turn over.
  }
}

/** Add a point to a session's history, keeping the file it belongs to consistent. */
export function appendSnapshot(sessionId: string, root: string, record: SnapshotRecord): SnapshotFile {
  const existing = readSnapshots(sessionId);
  // Reopened somewhere else, so the old commits describe a tree this one knows nothing of.
  const snapshots = existing && existing.root === root ? existing.snapshots : [];

  const file: SnapshotFile = { version: VERSION, root, snapshots: [...snapshots, record] };
  writeSnapshots(sessionId, file);
  return file;
}
