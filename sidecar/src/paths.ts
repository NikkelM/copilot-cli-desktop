import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

/** Root of the Copilot CLI's own state directory. Override for testing against a fixture. */
export const copilotHome = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');

/** Read-only history index the sidebar is built from. Written by the CLI itself. */
export const sessionStoreDb = join(copilotHome, 'session-store.db');

/** Per-session directory holding events.jsonl, checkpoints and rewind snapshots. */
export function sessionStateDir(sessionId: string): string {
  return join(copilotHome, 'session-state', sessionId);
}

/** Full event stream for a session, one JSON object per line, in SDK SessionEvent shape. */
export function sessionEventLog(sessionId: string): string {
  return join(sessionStateDir(sessionId), 'events.jsonl');
}

/**
 * The session's own SQL database, which is where the agent keeps its todo list.
 *
 * Read directly rather than through the runtime, for the same reason the event log is: a
 * session that is not loaded has no process to ask, and this app exists not to start one.
 */
export function sessionDatabase(sessionId: string): string {
  return join(sessionStateDir(sessionId), 'session.db');
}

/** Name of the CLI binary itself, not a shell wrapper: the SDK spawns this without a shell. */
const cliBinary = process.platform === 'win32' ? 'copilot.exe' : 'copilot';

/**
 * The executable a terminal on this machine would run.
 * Covers every installer that puts the real binary on PATH - winget, scoop, a manual copy - without naming any of them, and keeps the app on the same CLI the user sees.
 *
 * npm installs are deliberately not served here: on Windows npm writes a `.cmd` shim rather than an `.exe`, so this misses them and the package candidates below pick them up instead.
 */
function onPath(): string | null {
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, cliBinary);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Locate the Copilot CLI executable that the SDK should drive.
 * The SDK spawns this once and hosts every session inside it.
 */
export function resolveCliPath(): string | null {
  if (process.env.COPILOT_CLI_PATH && existsSync(process.env.COPILOT_CLI_PATH)) {
    return process.env.COPILOT_CLI_PATH;
  }

  const onPathCandidate = onPath();
  if (onPathCandidate) return onPathCandidate;

  const platformPackage =
    process.platform === 'win32'
      ? join('@github', 'copilot-win32-x64', 'copilot.exe')
      : process.platform === 'darwin'
        ? join('@github', 'copilot-darwin-arm64', 'copilot')
        : join('@github', 'copilot-linux-x64', 'copilot');

  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@github', 'copilot', 'node_modules', platformPackage),
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@github', 'copilot', 'node_modules', platformPackage),
    '/usr/local/lib/node_modules/@github/copilot/node_modules/' + platformPackage.split('\\').join('/'),
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}
