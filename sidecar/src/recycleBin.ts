import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { sessionStateDir } from './paths.js';

/**
 * Deleting a session, deferred.
 *
 * A session is a directory of transcript, checkpoints and rewind snapshots, and deleting it
 * used to be final the instant it was asked for. So this holds the directory somewhere else
 * for a while instead: long enough to change your mind, and no longer, since a bin nobody
 * empties is a disk that fills.
 *
 * Moving rather than copying is what makes this cheap enough to be the default. The CLI is
 * not told anything: it lists sessions by reading that directory, so a session whose
 * directory is elsewhere is one it does not have, and one moved back is one it does again.
 * The row in the history database is left alone through all of this, which is why a
 * restored session comes back with its title and its place in the list intact.
 */

/** What a binned session is remembered by, written beside it rather than inside it. */
export interface BinnedSession {
  sessionId: string;
  /** What the sidebar called it, so the bin can be read without asking the CLI anything. */
  title: string | null;
  /** ISO-8601, when it was binned. What the retention is counted from. */
  binnedAt: string;
  /** ISO-8601, when it was last used, so the bin can be ordered like the list it came from. */
  updatedAt: string | null;
  /** Bytes on disk, so emptying the bin can say what it is worth. */
  bytes: number;
}

/**
 * Where the bin lives.
 *
 * Beside the app's own settings, because that is where this app's data goes and a bin
 * somewhere else would be a second place to look for it. The shell passes this in: the
 * sidecar is a plain node process and has no idea where Tauri puts things.
 *
 * Read on every call rather than held, so a test can move it.
 */
export function binDir(): string | null {
  const home = process.env.COPILOT_DESKTOP_DATA;
  return home ? join(home, 'recycle-bin') : null;
}

/** The two halves of a binned session: the directory that was moved, and what it was. */
function paths(bin: string, sessionId: string) {
  return { dir: join(bin, sessionId), note: join(bin, `${sessionId}.json`) };
}

/** Everything under a directory, added up. */
function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

/**
 * Move a session's directory into the bin.
 *
 * Renamed where the two are on one volume, which they are whenever the app's data and the
 * CLI's are both under the same home, and copied where they are not. A copy is only reached
 * for once the rename has actually failed: guessing from the paths would mean copying
 * gigabytes on a machine where a rename would have done.
 *
 * Answers whether there was anything to bin. A session with no directory is already gone.
 */
export function binSession(sessionId: string, title: string | null, updatedAt: string | null): boolean {
  const bin = binDir();
  const from = sessionStateDir(sessionId);
  if (!bin || !existsSync(from)) return false;

  mkdirSync(bin, { recursive: true });
  const { dir, note } = paths(bin, sessionId);
  // Whatever is there is a session of the same id binned before this one, which this one
  // supersedes: the id is the same session, so the older copy is the older state of it.
  rmSync(dir, { recursive: true, force: true });

  try {
    renameSync(from, dir);
  } catch {
    cpSync(from, dir, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }

  const kept: BinnedSession = { sessionId, title, binnedAt: new Date().toISOString(), updatedAt, bytes: sizeOf(dir) };
  writeFileSync(note, JSON.stringify(kept, null, 2), 'utf8');
  return true;
}

/**
 * What is in the bin, newest first.
 *
 * Built from the notes rather than from the directories, so a directory left behind by a
 * half-finished move is not offered as something to restore. The other way round - a note
 * with no directory - is dropped for the same reason.
 */
export function binnedSessions(): BinnedSession[] {
  const bin = binDir();
  if (!bin || !existsSync(bin)) return [];

  const found: BinnedSession[] = [];
  for (const entry of readdirSync(bin)) {
    if (!entry.endsWith('.json')) continue;
    const sessionId = entry.slice(0, -'.json'.length);
    if (!existsSync(join(bin, sessionId))) continue;

    try {
      const parsed = JSON.parse(readFileSync(join(bin, entry), 'utf8')) as Partial<BinnedSession>;
      if (typeof parsed.binnedAt !== 'string') continue;
      found.push({
        sessionId,
        title: typeof parsed.title === 'string' ? parsed.title : null,
        binnedAt: parsed.binnedAt,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        bytes: typeof parsed.bytes === 'number' ? parsed.bytes : 0,
      });
    } catch {
      // A note that cannot be read is one this cannot offer to restore, and deleting it
      // would throw away the directory it names on the strength of a parse failure.
    }
  }

  return found.sort((a, b) => b.binnedAt.localeCompare(a.binnedAt));
}

/**
 * Put a session back where the CLI looks for it.
 *
 * Refuses rather than overwrites when something is already there: that would be a live
 * session of the same id, and replacing it with an older copy of itself loses whatever has
 * happened since.
 */
export function restoreSession(sessionId: string): boolean {
  const bin = binDir();
  if (!bin) return false;

  const { dir, note } = paths(bin, sessionId);
  const to = sessionStateDir(sessionId);
  if (!existsSync(dir) || existsSync(to)) return false;

  try {
    renameSync(dir, to);
  } catch {
    cpSync(dir, to, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  }

  rmSync(note, { force: true });
  return true;
}

/** Delete a binned session for good. */
export function purgeSession(sessionId: string): void {
  const bin = binDir();
  if (!bin) return;

  const { dir, note } = paths(bin, sessionId);
  rmSync(dir, { recursive: true, force: true });
  rmSync(note, { force: true });
}

/**
 * Delete whatever has been in the bin longer than it was meant to be.
 *
 * Counted from when it was binned rather than from when it was last used: the promise is
 * that deleting can be undone for so many days, and a session nobody had touched for a
 * month would otherwise be past its retention the moment it was deleted.
 *
 * Zero days is not swept here. It means there is no bin at all, so deleting is immediate
 * and nothing was ever put in one - but anything binned while the setting was higher stays
 * until it is asked for, rather than being taken away by a change of setting.
 */
export function sweepBin(retentionDays: number, now = Date.now()): number {
  if (retentionDays <= 0) return 0;

  const oldest = now - retentionDays * 24 * 60 * 60 * 1000;
  let swept = 0;
  for (const binned of binnedSessions()) {
    if (Date.parse(binned.binnedAt) > oldest) continue;
    purgeSession(binned.sessionId);
    swept += 1;
  }
  return swept;
}
