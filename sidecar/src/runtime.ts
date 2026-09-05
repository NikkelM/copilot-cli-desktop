import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type PermissionRequestResult,
  type SessionEvent,
} from '@github/copilot-sdk';

import { resolveCliPath } from './paths.js';

/** How a session answers tool permission requests. */
export type ApprovalPolicy = 'prompt' | 'approve-all';

interface LoadedSession {
  session: CopilotSession;
  unsubscribe: () => void;
  /** True between a turn starting and the session going idle. Busy sessions are never evicted. */
  busy: boolean;
  policy: ApprovalPolicy;
  idleTimer: NodeJS.Timeout | null;
}

export interface RuntimeOptions {
  /** Sessions kept resumed at once before the least recently used is disconnected. */
  maxLoadedSessions?: number;
  /** Disconnect an untouched session after this long. Zero disables the timer. */
  idleTimeoutMs?: number;
  /** Receives every session event, for forwarding to the UI. */
  onEvent?: (sessionId: string, event: SessionEvent) => void;
  /** Notifies that a session's loaded state changed, so the sidebar can update. */
  onLoadedChange?: (sessionId: string, loaded: boolean) => void;
}

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
 * browsing history costs nothing. Nothing here starts until the first send, and the
 * least recently used session is disconnected once the cap is exceeded.
 */
export class SessionRuntime {
  private client: CopilotClient | null = null;
  /** In-flight client start, so concurrent sends share one server. */
  private starting: Promise<CopilotClient> | null = null;

  private readonly loaded = new Map<string, LoadedSession>();
  /** In-flight resumes, so concurrent sends to one session resume it once. */
  private readonly resuming = new Map<string, Promise<CopilotSession>>();
  /** Session IDs currently resumed, ordered most-recently-used first. */
  private readonly order: string[] = [];

  private readonly maxLoadedSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly onEvent?: (sessionId: string, event: SessionEvent) => void;
  private readonly onLoadedChange?: (sessionId: string, loaded: boolean) => void;

  constructor(options: RuntimeOptions = {}) {
    this.maxLoadedSessions = options.maxLoadedSessions ?? 2;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.onEvent = options.onEvent;
    this.onLoadedChange = options.onLoadedChange;
  }

  /** Whether the CLI executable could be located on this machine. */
  static probeInstallation(): { cliPath: string | null } {
    return { cliPath: resolveCliPath() };
  }

  status() {
    return {
      serverRunning: this.client !== null,
      activeSessionIds: [...this.order],
      maxLoadedSessions: this.maxLoadedSessions,
    };
  }

  isActive(sessionId: string): boolean {
    return this.loaded.has(sessionId);
  }

  /**
   * Start the shared CLI server, or return the running one.
   *
   * Deliberately not called at app launch: an app that is open but idle should cost
   * nothing beyond the shell itself.
   */
  private async ensureClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;

    const starting = (async () => {
      const cliPath = resolveCliPath();

      // One server process hosts every session; that is the whole point of the design.
      // Stdio avoids opening a listening port for something only this app talks to.
      const client = new CopilotClient({
        connection: RuntimeConnection.forStdio(cliPath ? { path: cliPath } : {}),
      });

      await client.start();
      return client;
    })();

    this.starting = starting;
    try {
      this.client = await starting;
      return this.client;
    } finally {
      // Cleared either way, so a failed start can be retried by a later send.
      this.starting = null;
    }
  }

  /** Resume a session if it is not already loaded, evicting another if needed. */
  private async ensureSession(sessionId: string): Promise<CopilotSession> {
    const existing = this.loaded.get(sessionId);
    if (existing) {
      this.touch(sessionId);
      return existing.session;
    }

    const inFlight = this.resuming.get(sessionId);
    if (inFlight) return inFlight;

    const pending = this.resume(sessionId).finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, pending);
    return pending;
  }

  private async resume(sessionId: string): Promise<CopilotSession> {
    const client = await this.ensureClient();

    const session = await client.resumeSession(sessionId, {
      onPermissionRequest: () => this.decidePermission(sessionId),
      streaming: true,
    });

    const unsubscribe = session.on((event: SessionEvent) => this.handleEvent(sessionId, event));

    this.loaded.set(sessionId, {
      session,
      unsubscribe,
      busy: false,
      policy: 'prompt',
      idleTimer: null,
    });
    this.touch(sessionId);
    this.onLoadedChange?.(sessionId, true);

    await this.enforceCap();
    return session;
  }

  /**
   * Answer a tool permission request.
   *
   * Until the approval UI exists there is genuinely no user to ask, so the honest
   * answer is `user-not-available` rather than silently approving. A session can opt
   * into blanket approval, mirroring the CLI's --allow-all.
   */
  private decidePermission(sessionId: string): PermissionRequestResult {
    const entry = this.loaded.get(sessionId);
    return entry?.policy === 'approve-all'
      ? { kind: 'approve-for-session' }
      : { kind: 'user-not-available' };
  }

  setApprovalPolicy(sessionId: string, policy: ApprovalPolicy): void {
    const entry = this.loaded.get(sessionId);
    if (entry) entry.policy = policy;
  }

  private handleEvent(sessionId: string, event: SessionEvent): void {
    const entry = this.loaded.get(sessionId);

    if (entry) {
      // Track turn boundaries so a session mid-turn is never evicted underneath itself.
      if (event.type === 'assistant.turn_start') entry.busy = true;
      if (event.type === 'session.idle' || event.type === 'assistant.turn_end') entry.busy = false;

      this.touch(sessionId);
    }

    this.onEvent?.(sessionId, event);
  }

  /** Mark a session most recently used and restart its idle countdown. */
  private touch(sessionId: string): void {
    const index = this.order.indexOf(sessionId);
    if (index !== -1) this.order.splice(index, 1);
    this.order.unshift(sessionId);

    const entry = this.loaded.get(sessionId);
    if (!entry) return;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.idleTimeoutMs > 0) {
      entry.idleTimer = setTimeout(() => {
        void this.evict(sessionId);
      }, this.idleTimeoutMs);
      entry.idleTimer.unref(); // Never keep the sidecar alive just to evict.
    }
  }

  /** Disconnect least recently used sessions until the cap is satisfied. */
  private async enforceCap(): Promise<void> {
    for (let i = this.order.length - 1; i >= 0 && this.order.length > this.maxLoadedSessions; i -= 1) {
      const candidate = this.order[i];
      if (!candidate) continue;
      if (this.loaded.get(candidate)?.busy) continue; // Let the turn finish first.
      await this.evict(candidate);
    }
  }

  /**
   * Release a session's memory while preserving it on disk.
   *
   * `disconnect()` is not destructive: the session can be resumed again later with its
   * history intact, which is what makes automatic eviction safe.
   */
  async evict(sessionId: string): Promise<void> {
    const entry = this.loaded.get(sessionId);
    if (!entry || entry.busy) return;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.unsubscribe();
    this.loaded.delete(sessionId);

    const index = this.order.indexOf(sessionId);
    if (index !== -1) this.order.splice(index, 1);

    try {
      await entry.session.disconnect();
    } finally {
      this.onLoadedChange?.(sessionId, false);
    }
  }

  /** Resume the session if needed, then send. Returns the resulting message id. */
  async send(sessionId: string, prompt: string, mode?: 'enqueue' | 'immediate'): Promise<string> {
    const session = await this.ensureSession(sessionId);
    return session.send({ prompt, ...(mode ? { mode } : {}) });
  }

  /** Stop the current turn without unloading the session. */
  async abort(sessionId: string): Promise<void> {
    await this.loaded.get(sessionId)?.session.abort();
  }

  /** Release every session and stop the shared server. */
  async shutdown(): Promise<void> {
    for (const sessionId of [...this.order]) {
      const entry = this.loaded.get(sessionId);
      if (entry) entry.busy = false; // Shutdown takes precedence over an in-flight turn.
      await this.evict(sessionId).catch(() => undefined);
    }

    const client = this.client;
    this.client = null;
    if (client) await client.stop().catch(() => undefined);
  }
}
