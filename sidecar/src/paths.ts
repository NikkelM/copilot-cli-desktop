import { homedir } from 'node:os';
import { join } from 'node:path';
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
 * Where this app keeps what belongs to it.
 *
 * Deliberately outside `.copilot`, which belongs to the CLI and is only read. Writing there
 * worked, but left files nobody would ever clean up: uninstalling this app is scoped to its
 * own directories, so anything it scattered through the CLI's would have stayed forever.
 *
 * The shell passes the directory Tauri resolved, so both halves agree on one location. The
 * fallback is for the sidecar running on its own - tests, and the scripts in `scripts/`.
 */
export const desktopDataDir =
  process.env.COPILOT_DESKTOP_DATA ??
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
    'com.nikkelm.copilot-cli-desktop',
  );

/**
 * Locate the Copilot CLI executable that the SDK should drive.
 * The SDK spawns this once and hosts every session inside it.
 */
export function resolveCliPath(): string | null {
  if (process.env.COPILOT_CLI_PATH && existsSync(process.env.COPILOT_CLI_PATH)) {
    return process.env.COPILOT_CLI_PATH;
  }

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
