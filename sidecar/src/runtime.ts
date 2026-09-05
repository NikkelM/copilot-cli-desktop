import type { RuntimeStatus } from '../../shared/protocol.js';
import { resolveBundledSdkPath, resolveCliPath } from './paths.js';

/**
 * Owns the single shared Copilot CLI server process and decides which sessions
 * are allowed to occupy memory.
 *
 * Measured rationale (8 sessions open in the plain CLI vs one shared server):
 *   - CLI today: 22 processes, ~1.1 GB working set, ~13.2 GB commit
 *   - One shared server, idle: ~206 MB working set, ~250 MB commit
 *   - Same server with 3 sessions resumed: ~865 MB working set, ~1.0 GB commit
 *
 * Loading a session therefore costs real memory and 1.5-6 s of wall time, while
 * browsing history costs nothing. Sessions are only resumed when the user actually
 * sends a message, and the least recently used one is disconnected past the cap.
 */
export class SessionRuntime {
  /** Session IDs currently resumed, ordered most-recently-used first. */
  private readonly active: string[] = [];

  constructor(private readonly maxLoadedSessions = 2) {}

  status(): RuntimeStatus {
    return {
      serverRunning: false, // TODO(phase2): true once the CopilotClient is started.
      activeSessionIds: [...this.active],
      maxLoadedSessions: this.maxLoadedSessions,
    };
  }

  /** Whether the CLI and its bundled SDK could be located on this machine. */
  static probeInstallation(): { cliPath: string | null; sdkPath: string | null } {
    return { cliPath: resolveCliPath(), sdkPath: resolveBundledSdkPath() };
  }

  /**
   * Record a session as most recently used, returning any session that must be
   * evicted to stay within the cap.
   */
  touch(sessionId: string): string | null {
    const existing = this.active.indexOf(sessionId);
    if (existing !== -1) this.active.splice(existing, 1);
    this.active.unshift(sessionId);

    return this.active.length > this.maxLoadedSessions ? (this.active.pop() ?? null) : null;
  }

  /** Drop a session from the active set, e.g. after disconnecting it. */
  release(sessionId: string): void {
    const idx = this.active.indexOf(sessionId);
    if (idx !== -1) this.active.splice(idx, 1);
  }

  isActive(sessionId: string): boolean {
    return this.active.includes(sessionId);
  }
}

// TODO(phase2): back SessionRuntime with @github/copilot-sdk.
//   - new CopilotClient({ cliPath }) started lazily on the first send, not at app launch
//   - resumeSession(id, { onPermissionRequest }) when the user sends into a cold session
//   - session.disconnect() on eviction; it frees memory but preserves on-disk state
//   - client.on('session.updated', ...) to refresh the sidebar without polling
