import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { sessionStateDir } from './paths.js';

/**
 * The directories a session may reach beyond the one it works in, the app's `--add-dir`.
 *
 * The runtime takes these as `additionalDirectories` and says plainly that it does not keep
 * them: applied on creation and cold resume, never persisted, so a cold resume has to supply
 * them again. This app evicts idle sessions on purpose, so a directory added through the
 * runtime alone would be gone the next time that session came back. The list is kept beside
 * the session's own record and handed over on every create and resume, exactly as the
 * disabled skills are, and for the same reason.
 *
 * Adding one is a trust decision rather than only an access one: the runtime loads
 * `.github/skills/` and `.github/agents/` found under an added directory into the session.
 */
function storePath(sessionId: string): string {
  return join(sessionStateDir(sessionId), 'desktop-directories.json');
}

interface Stored {
  directories: string[];
}

/**
 * Absolute, and without the trailing separator a folder picker may leave on a drive root.
 *
 * Relative paths would be resolved by the runtime against the session's working directory,
 * which is not this process's, so they are made absolute here where the answer is knowable
 * rather than sent somewhere they would mean something else.
 */
function normalise(path: string): string {
  return resolve(path);
}

/**
 * The extra directories this session has been given.
 *
 * Anything unreadable is treated as none rather than an error, as the skills store does: a
 * damaged preferences file should cost the reader their list, not their session.
 */
export function extraDirectories(sessionId: string): string[] {
  const path = storePath(sessionId);
  if (!existsSync(path)) return [];

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Stored;
    if (!Array.isArray(parsed.directories)) return [];
    return parsed.directories.filter((entry) => typeof entry === 'string');
  } catch {
    return [];
  }
}

function write(sessionId: string, directories: string[]): string[] {
  const path = storePath(sessionId);

  // No extra directories is the default, so the file goes rather than holding an empty
  // list: a session that was never given one and a session returned to its defaults are
  // the same session and should leave the same trace.
  if (directories.length === 0) {
    rmSync(path, { force: true });
    return directories;
  }

  mkdirSync(sessionStateDir(sessionId), { recursive: true });
  writeFileSync(path, JSON.stringify({ directories }, null, 2));
  return directories;
}

/**
 * Give a session another directory, and report the whole list afterwards.
 *
 * Refuses what is not a directory here rather than passing it on. The runtime skips an
 * entry it cannot resolve with a warning the reader never sees, which would leave a path
 * sitting in the list looking granted while the agent could not reach it.
 */
export function addDirectory(sessionId: string, path: string): string[] {
  const wanted = normalise(path);
  if (!existsSync(wanted) || !statSync(wanted).isDirectory()) {
    throw new Error(`Not a directory: ${wanted}`);
  }

  const current = extraDirectories(sessionId);
  if (current.includes(wanted)) return current;

  return write(sessionId, [...current, wanted].sort());
}

/** Take a directory back off a session, and report the whole list afterwards. */
export function removeDirectory(sessionId: string, path: string): string[] {
  const wanted = normalise(path);
  const current = extraDirectories(sessionId);
  if (!current.includes(wanted)) return current;

  return write(
    sessionId,
    current.filter((entry) => entry !== wanted),
  );
}
