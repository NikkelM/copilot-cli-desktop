/**
 * What each session is costing on disk.
 *
 * `~/.copilot/session-state` grows and nothing ever takes anything out of it, so the
 * question "what is using all this" has no answer anywhere - not in this app, and not in the
 * CLI (#29).
 *
 * Measured rather than guessed, because guessing gets it wrong. A session's event log is 88%
 * of its bytes, so reading only that is fifty times quicker - and it puts the sessions in a
 * different order, because the ones with thousands of rewind backups are not the ones with
 * the longest logs. A list that ranks by size has to rank correctly or it is pointing at the
 * wrong sessions.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionDisk } from '../../shared/protocol.js';
import { copilotHome } from './paths.js';
import { listSessions } from './sessionIndex.js';

/**
 * How many directories are walked at once.
 *
 * Measured over 753 real session directories holding 3.6GB: one at a time is 593ms, eight
 * is 396, thirty-two is 258, and a hundred and twenty-eight is slower again at 290. The
 * whole walk is the same work either way - what changes is how much of it is waiting.
 */
const AT_ONCE = 32;

/** Everything under a directory, added up, without holding the thread while it counts. */
async function sizeOf(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Gone between listing and walking, which a session being deleted elsewhere can do.
    return 0;
  }

  const found = entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sizeOf(path);
    if (!entry.isFile()) return 0;
    return stat(path).then(
      (info) => info.size,
      () => 0,
    );
  });

  return (await Promise.all(found)).reduce((total, size) => total + size, 0);
}

/**
 * What every session on disk is using, largest first.
 *
 * Asynchronous throughout, unlike the same walk in the recycle bin, and for a reason rather
 * than for symmetry: the bin holds a handful of entries where this holds every session there
 * has ever been. The same walk written synchronously takes 2.6 seconds here, and the sidecar
 * answers nothing at all while it runs - every other window in the app would stop with it.
 *
 * Directories are the truth rather than the session store, since what is being asked about is
 * disk: a session the store has forgotten still has its bytes, and those are exactly the ones
 * worth finding. Its title comes from the store where the store still knows it.
 */
export async function sessionDiskUsage(): Promise<SessionDisk[]> {
  const root = join(copilotHome, 'session-state');

  let dirs;
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    // No directory at all is a CLI that has never run, not a failure worth reporting.
    return [];
  }

  const known = new Map(listSessions().map((session) => [session.sessionId, session]));
  const found: SessionDisk[] = [];

  for (let at = 0; at < dirs.length; at += AT_ONCE) {
    const batch = dirs.slice(at, at + AT_ONCE);
    const sizes = await Promise.all(batch.map((entry) => sizeOf(join(root, entry.name))));

    batch.forEach((entry, index) => {
      const session = known.get(entry.name);
      found.push({
        sessionId: entry.name,
        title: session?.title ?? null,
        updatedAt: session?.updatedAt ?? null,
        bytes: sizes[index] ?? 0,
        // A directory the store has no row for. Worth saying rather than hiding: it is
        // still taking up room, and nothing else in the app will ever mention it.
        listed: session !== undefined,
      });
    });
  }

  return found.sort((a, b) => b.bytes - a.bytes);
}
