import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type ElicitationContext,
  type ElicitationResult,
  type ExitPlanModeRequest,
  type ExitPlanModeResult,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from '@github/copilot-sdk';

import type {
  McpServerState,
  Attachment,
  CommandOutcome,
  ContextTier,
  ElicitationAction,
  ElicitationFieldValue,
  PermissionChoice,
  PlanAction,
  ReasoningEffort,
  ShellResult,
  QueuedItem,
  SessionContextUsage,
  SessionUsage,
  SessionMode,
  SlashCommand,
} from '../../shared/protocol.js';
import { DEFAULT_BIN_RETENTION_DAYS, DEFAULT_PERMISSION_TIMEOUT_MS } from '../../shared/protocol.js';
import type { BinnedSession } from '../../shared/protocol.js';
import { homedir } from 'node:os';

import { resolveCliPath } from './paths.js';
import { stripAnsi } from '../../shared/ansi.js';
import { lastMode, lastUsage } from './eventLog.js';

import { PendingRequests } from './pending.js';
import { disabledSkills, setSkillDisabled } from './skills.js';
import { nameState, listSessions } from './sessionIndex.js';
import { binSession, binnedSessions, restoreSession, sweepBin } from './recycleBin.js';
import { Discovery } from './discovery.js';
import { coauthorEnabled } from './cliSettings.js';
import { TITLE_QUESTION, isPlaceholder, titleIn } from './sessionTitle.js';

/**
 * The legacy ask_user shapes. Declared here because the package root does not re-export
 * them, though they are what `onUserInputRequest` is handed and must return.
 */
interface UserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

interface UserInputResponse {
  answer: string;
  wasFreeform: boolean;
}

/**
 * How much of a running tool's output is worth forwarding.
 *
 * Four times what the transcript will show, so ANSI escapes stripped on the way to the
 * screen cannot leave it short of a full view.
 */
const MAX_PARTIAL_OUTPUT = 16_000;

/** How a question was posed, which decides the shape of the answer. */
export interface AskContext {
  kind: 'input' | 'form';
  message: string;
  schema: Record<string, unknown> | null;
  choices: string[];
  mode: 'form' | 'url' | null;
  url: string | null;
}

/**
 * The ways forward a plan can be approved with.
 *
 * The SDK types these as plain strings, so they are narrowed here rather than trusted.
 * An action this app does not know how to draw is dropped instead of being offered as a
 * button with no meaning; approving without choosing one is still allowed, so a plan
 * whose options are all unknown can be accepted or turned down as usual.
 */
const PLAN_ACTIONS: readonly PlanAction[] = ['exit_only', 'interactive', 'autopilot', 'autopilot_fleet'];

function knownPlanAction(action: string): PlanAction | null {
  return PLAN_ACTIONS.find((known) => known === action) ?? null;
}

function knownPlanActions(actions: string[]): PlanAction[] {
  return actions.map(knownPlanAction).filter((action): action is PlanAction => action !== null);
}

/**
 * One server process hosts every session; that is the whole point of the design.
 * Stdio avoids opening a listening port for something only this app talks to.
 */
async function defaultClientFactory(): Promise<CopilotClient> {
  const cliPath = resolveCliPath();
  return new CopilotClient({
    connection: RuntimeConnection.forStdio(cliPath ? { path: cliPath } : {}),
  });
}

/** A request waiting on the user, with the resolver that unblocks the agent. */
interface LoadedSession {
  session: CopilotSession;
  unsubscribe: () => void;
  /** True between a turn starting and the session going idle. Busy sessions are never evicted. */
  busy: boolean;
  /** The last prompt sent, so a turn's record can name what caused it as the CLI's does. */
  lastPrompt?: string;
  idleTimer: NodeJS.Timeout | null;
}

export interface RuntimeOptions {
  /** Sessions kept resumed at once before the least recently used is disconnected. */
  /**
   * Most sessions resident at once before the least recently used is disconnected.
   *
   * Zero, the default, means no cap: how many sessions are worth keeping is the reader's
   * judgement, not this app's, and the idle timer already reclaims what is not being used.
   * A number is still honoured, since the eviction path has to stay testable.
   */
  maxLoadedSessions?: number;
  /** Disconnect an untouched session after this long. Zero disables the timer. */
  idleTimeoutMs?: number;
  /** How long a permission request waits for the user before giving up. */
  permissionTimeoutMs?: number;
  /** Receives every session event, for forwarding to the UI. */
  onEvent?: (sessionId: string, event: SessionEvent) => void;
  /**
   * Notifies that a session's loaded state changed, so the sidebar can update.
   *
   * `loading` is a resume in flight, which is neither loaded nor not: it is the only one of
   * the three that takes long enough to be worth drawing, and the reader who asked for it is
   * watching the row they asked about (#107).
   */
  onLoadedChange?: (sessionId: string, loaded: boolean, loading?: boolean) => void;
  /**
   * A turn's changes were written to the session's rewind store.
   *
   * Sent only when there was something to write, so a panel showing what a session changed
   * refreshes when the answer moves and stays still the rest of the time.
   */
  onChangesRecorded?: (sessionId: string) => void;
  /**
   * Asks the UI to approve or deny a tool call.
   *
   * xpiresAt is when the request lapses on its own: a blocked agent is the one wait that
   * ends badly if nobody notices it, so the prompt can say how long is left (#70).
   */
  onPermissionRequest?: (
    sessionId: string,
    requestId: string,
    request: PermissionRequest,
    expiresAt: string | null,
  ) => void;
  /** Tells the UI a pending request is no longer awaiting an answer. */
  onPermissionResolved?: (sessionId: string, requestId: string) => void;
  /** Asks the UI to put a question from the agent to the user. Lapses like a permission. */
  onElicitationRequest?: (
    sessionId: string,
    requestId: string,
    context: AskContext,
    expiresAt: string | null,
  ) => void;
  /** Tells the UI a question is no longer awaiting an answer. */
  onElicitationResolved?: (requestId: string) => void;
  /** Asks the UI to put the agent's plan to the user for approval. Lapses like a question. */
  onPlanRequest?: (
    sessionId: string,
    requestId: string,
    plan: { summary: string; planContent: string; actions: PlanAction[]; recommendedAction: PlanAction },
    expiresAt: string | null,
  ) => void;
  /** Tells the UI a plan is no longer awaiting a decision. */
  onPlanResolved?: (requestId: string) => void;
  /**
   * Overrides how the CLI client is created.
   * Exists so the eviction and permission rules can be exercised without spawning a real
   * CLI, since those govern the memory behaviour the whole app is built around.
   */
  createClient?: () => Promise<CopilotClient>;
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
  /**
   * What the machine offers, as against what a conversation holds.
   *
   * Its own object because none of it reads `loaded`, touches the idle timer, or can evict
   * anything - and because it is where the work keeps going, while these rules are where
   * the care has to stay (#183).
   *
   * It borrows this runtime's client rather than starting one, so there is still a single
   * server process for the whole app.
   */
  readonly discovery = new Discovery(() => this.ensureClient());

  private readonly loaded = new Map<string, LoadedSession>();
  /** In-flight resumes, so concurrent sends to one session resume it once. */
  private readonly resuming = new Map<string, Promise<CopilotSession>>();
  /** Session IDs currently resumed, ordered most-recently-used first. */
  private readonly order: string[] = [];

  private maxLoadedSessions: number;
  private idleTimeoutMs: number;
  /**
   * How many days a deleted session is kept before it is really deleted.
   *
   * Starts at what the app's own settings start at rather than at zero, so a delete that
   * happens before the app has said anything can still be undone. The wrong guess in that
   * direction costs a directory for a week; the other loses it for good.
   */
  private binRetentionDays = DEFAULT_BIN_RETENTION_DAYS;
  /**
   * How long a question to the reader waits before it answers itself.
   *
   * One number for all four kinds - permissions, questions, prompts for input and plans -
   * because they are one thing to a reader: how long the agent waits for them. Each still
   * lapses to its own answer, which is the "no" of its kind.
   *
   * Zero never gives up, which is the honest name for wanting to answer whenever you get
   * back rather than come home to a decision made on your behalf.
   */
  private permissionTimeoutMs: number;
  /**
   * Sessions this run has already tried to title, whether or not it managed to.
   *
   * A session that could not be titled after its first turn will be no easier after its
   * twentieth, and asking again on every idle would spend a model call each time.
   */
  private readonly titled = new Set<string>();
  /** The model titles are written on when the session's own cannot answer. Asked once. */
  private titlingModel: string | null | undefined = undefined;
  private readonly onEvent?: (sessionId: string, event: SessionEvent) => void;
  private readonly onLoadedChange?: (sessionId: string, loaded: boolean, loading?: boolean) => void;
  private readonly onChangesRecorded?: (sessionId: string) => void;
  private readonly onPermissionRequest?: (
    sessionId: string,
    requestId: string,
    request: PermissionRequest,
    expiresAt: string | null,
  ) => void;
  private readonly onPermissionResolved?: (sessionId: string, requestId: string) => void;
  private readonly onElicitationRequest?: (
    sessionId: string,
    requestId: string,
    context: AskContext,
    expiresAt: string | null,
  ) => void;
  private readonly onElicitationResolved?: (requestId: string) => void;
  private readonly onPlanRequest?: (
    sessionId: string,
    requestId: string,
    plan: { summary: string; planContent: string; actions: PlanAction[]; recommendedAction: PlanAction },
    expiresAt: string | null,
  ) => void;
  private readonly onPlanResolved?: (requestId: string) => void;
  private readonly createClient: () => Promise<CopilotClient>;

  /** Tool calls waiting on an approve or deny decision. */
  private readonly permissions: PendingRequests<PermissionRequestResult>;
  /** Schema-driven questions waiting on an answer. */
  private readonly elicitations: PendingRequests<ElicitationResult>;
  /** Legacy ask_user questions waiting on an answer. */
  private readonly userInputs: PendingRequests<UserInputResponse>;
  /** Plans waiting on the reader to approve them and say how to proceed. */
  private readonly plans: PendingRequests<ExitPlanModeResult>;

  constructor(options: RuntimeOptions = {}) {
    this.maxLoadedSessions = options.maxLoadedSessions ?? 0;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.onEvent = options.onEvent;
    this.onLoadedChange = options.onLoadedChange;
    this.onChangesRecorded = options.onChangesRecorded;
    this.onPermissionRequest = options.onPermissionRequest;
    this.onPermissionResolved = options.onPermissionResolved;
    this.onElicitationRequest = options.onElicitationRequest;
    this.onElicitationResolved = options.onElicitationResolved;
    this.onPlanRequest = options.onPlanRequest;
    this.onPlanResolved = options.onPlanResolved;
    this.createClient = options.createClient ?? defaultClientFactory;

    const permissionResolved = (sessionId: string, requestId: string) =>
      this.onPermissionResolved?.(sessionId, requestId);
    const questionResolved = (_sessionId: string, requestId: string) => this.onElicitationResolved?.(requestId);
    // Read per request rather than captured, so a change of setting reaches the next
    // question rather than only the next sidecar.
    const timeout = () => this.permissionTimeoutMs;

    this.permissions = new PendingRequests<PermissionRequestResult>(
      'perm',
      timeout,
      () => ({ kind: 'user-not-available' }),
      permissionResolved,
    );
    // Giving up on a question is a decline: the agent asked and nobody answered.
    this.elicitations = new PendingRequests<ElicitationResult>(
      'elicit',
      timeout,
      () => ({ action: 'decline' }),
      questionResolved,
    );
    this.userInputs = new PendingRequests<UserInputResponse>(
      'input',
      timeout,
      () => ({ answer: '', wasFreeform: true }),
      questionResolved,
    );
    // Nobody read the plan, so it is not approved. The SDK's own default is the opposite,
    // which is what made plan mode a checkpoint that never stopped anything (#167).
    this.plans = new PendingRequests<ExitPlanModeResult>(
      'plan',
      timeout,
      () => ({ approved: false }),
      (_sessionId, requestId) => this.onPlanResolved?.(requestId),
    );
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
      const client = await this.createClient();
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

  /**
   * Start a session, in a directory only if one is wanted.
   *
   * Not every session is about a project. Wanting to ask something quickly should not
   * begin with choosing a folder, so this defaults to the home directory the way running
   * the CLI without arguments does, and takes one when it matters.
   *
   * Costs a Copilot process, unlike everything else the sidebar does, so it happens on
   * asking rather than in anticipation. The session is left loaded because someone who
   * has just made one is about to write in it.
   */
  async create(
    workingDirectory?: string,
    defaults?: { allowAll?: boolean; model?: string; reasoningEffort?: ReasoningEffort; contextTier?: ContextTier },
  ): Promise<{ sessionId: string }> {
    const client = await this.ensureClient();
    const pluginDirectories = await this.discovery.pluginDirectories(client);

    // The handlers need the session's id, which does not exist until it does, so they
    // read it when called rather than closing over a value that is not there yet.
    let id = '';
    const session = await client.createSession({
      workingDirectory: workingDirectory ?? homedir(),
      // Given at creation rather than set afterwards, unlike the permission mode: these are
      // fields on the config the runtime already takes, so there is nothing to undo if they
      // are not wanted. Absent leaves the runtime's own choice, which is `auto`.
      ...(defaults?.model
        ? {
            model: defaults.model,
            // Only alongside a model: an effort or a room size on its own would be applied
            // to whatever the runtime chose, which is not what was asked for.
            ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort as never } : {}),
            ...(defaults.contextTier ? { contextTier: defaults.contextTier } : {}),
          }
        : {}),
      onPermissionRequest: (request) => this.decidePermission(id, request),
      onUserInputRequest: (request) => this.askUserInput(id, request),
      onElicitationRequest: (context) => this.askElicitation(id, context),
      // Registering this is what makes the runtime ask at all: the client sends
      // `requestExitPlanMode: !!onExitPlanModeRequest` as a capability, so leaving it off
      // told the runtime this host cannot approve plans and the request never came (#167).
      onExitPlanModeRequest: (request) => this.askExitPlan(id, request),
      // The runtime owns the rewind store, and only fills it when asked to. Asking on
      // creation is the only chance to get a complete record: capture starts with the
      // first turn and cannot be reconstructed later.
      enableFileChangeTracking: true,
      // Off by default, which left every session here without the reader's agents, skills
      // and instructions while the same session in a terminal had all three (#161). What
      // is set explicitly above still wins over anything discovered.
      enableConfigDiscovery: true,
      // Skills from installed plugins load only when their directories are named (#163).
      pluginDirectories,
      // Tokens are discarded with the session unless asked for otherwise, so an OAuth-backed
      // MCP server would ask to authenticate again on every resume - which this app does
      // constantly, evicting and reviving sessions under the cap. The keychain is the store
      // the CLI already writes to, so this shares those logins rather than opening a second
      // place to hold them (#162).
      mcpOAuthTokenStorage: 'persistent',
      // Read now rather than when the server started, which is when the CLI reads it too:
      // a session made after the setting changed gets the answer the reader last gave.
      coauthorEnabled: coauthorEnabled(),
      streaming: true,
    });

    id = session.sessionId;
    this.adopt(id, session);

    /**
     * Put it in the permission mode that was asked for, if it is not the one it starts in.
     *
     * Set here rather than given to the CLI when the shared server is spawned. That was
     * tried: `--allow-all` and `--yolo` on the server leave every session it creates in
     * `manual`, because the flags configure the process and the mode belongs to the
     * session. This is the call the runtime's own `/allow-all` makes (#199).
     *
     * Failure leaves the session asking, which is the safe direction: a session that asks
     * when it was meant not to is an annoyance, and the reverse is not.
     */
    if (defaults?.allowAll) {
      await session.rpc.permissions.setMode({ mode: 'allow-all' }).catch(() => undefined);
    }

    await this.enforceCap();
    return { sessionId: id };
  }

  /**
   * Bring a session into memory now, rather than on the next send.
   *
   * The opposite of `evict`, and the reason it exists: this app resumes nothing until
   * something is asked of it, which is what makes two hundred sessions free - but it also
   * means the first message of the day waits on a resume. Somebody who knows they are about
   * to use a session can pay that cost while they are still reading (#107).
   *
   * The session itself is discarded. Waking one is a request about memory rather than about
   * the conversation, and `ensureSession` has already put it where everything else looks.
   */
  async load(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
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
    // Said before anything is awaited, so a row shows it is coming rather than sitting still
    // for however long the CLI takes. Taken back by dopt on the way in, and below when
    // the resume fails - a row left pulsing over a session that is not coming would be worse
    // than never having said anything.
    this.onLoadedChange?.(sessionId, false, true);

    try {
      return await this.resumed(sessionId);
    } catch (error) {
      this.onLoadedChange?.(sessionId, false, false);
      throw error;
    }
  }

  private async resumed(sessionId: string): Promise<CopilotSession> {
    const client = await this.ensureClient();
    const pluginDirectories = await this.discovery.pluginDirectories(client);

    const session = await client.resumeSession(sessionId, {
      onPermissionRequest: (request) => this.decidePermission(sessionId, request),
      // The CLI picks one of two ask_user variants per session, so both are handled.
      // The legacy one arrives here as a user input request.
      onUserInputRequest: (request) => this.askUserInput(sessionId, request),
      onElicitationRequest: (context) => this.askElicitation(sessionId, context),
      // Also a capability, so a resumed session needs it as much as a new one.
      onExitPlanModeRequest: (request) => this.askExitPlan(sessionId, request),
      // Turns tracking on for a session that still has a baseline to track against. A
      // session that has run untracked turns keeps them untracked: the runtime cannot
      // reconstruct what it did not watch, and says so rather than guessing.
      enableFileChangeTracking: true,
      // As on creation (#161): a resumed session has to see the same agents, skills and
      // instructions the CLI would give it, or it quietly behaves like a different one.
      enableConfigDiscovery: true,
      // And the same answer about the commit trailer, or a session would sign its commits
      // differently depending on whether this app had evicted it since (#205).
      coauthorEnabled: coauthorEnabled(),
      // As on creation (#163): without these a resumed session is missing most of its skills.
      pluginDirectories,
      // The runtime's own per-session disable does not survive a resume, and this app
      // resumes constantly - a session evicted under the cap comes back through here. The
      // reader's choices are re-applied on the way in so they hold (#22).
      disabledSkills: disabledSkills(sessionId),
      // As on creation (#162): the resume this app performs constantly is exactly the moment
      // an in-memory token would already have been thrown away.
      mcpOAuthTokenStorage: 'persistent',
      streaming: true,
    });

    this.adopt(sessionId, session);
    await this.enforceCap();
    return session;
  }

  /**
   * Take charge of a session, however it came to exist.
   *
   * Resuming an old one and starting a new one differ only in how the session is obtained;
   * everything after - listening to it, counting it against the cap, telling the sidebar -
   * is the same, and was worth sharing rather than writing twice and letting them drift.
   */
  private adopt(sessionId: string, session: CopilotSession): void {
    const unsubscribe = session.on((event: SessionEvent) => this.handleEvent(sessionId, event));

    this.loaded.set(sessionId, {
      session,
      unsubscribe,
      busy: false,
      idleTimer: null,
    });
    this.touch(sessionId);
    this.onLoadedChange?.(sessionId, true, false);
  }

  /**
   * Answer a tool permission request by asking the user.
   *
   * There is no blanket approval here on purpose. The runtime has its own, reached through
   * `/allow-all` and `/permissions`, which stops it issuing a request at all rather than
   * approving one that was issued. That one is stored with the session, so it survives an
   * unload and the CLI honours it too; a flag of ours could do neither.
   *
   * The returned promise is what blocks the agent, so every path must settle it:
   * a user decision, the timeout, or the session being torn down.
   */
  private decidePermission(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<PermissionRequestResult> {
    // Without a listening UI there is genuinely nobody to ask, and reporting that is
    // more honest than silently approving.
    if (!this.onPermissionRequest) {
      return Promise.resolve({ kind: 'user-not-available' });
    }

    const { requestId, expiresAt, answered } = this.permissions.add(sessionId);
    this.onPermissionRequest(sessionId, requestId, request, expiresAt);
    return answered;
  }

  /** Apply the user's decision to a pending permission request. */
  resolvePermission(requestId: string, choice: PermissionChoice): void {
    const result: PermissionRequestResult =
      choice === 'approve-once'
        ? { kind: 'approve-once' }
        : choice === 'approve-for-session'
          ? { kind: 'approve-for-session' }
          : { kind: 'reject' };

    this.settlePermission(requestId, result);
  }

  private settlePermission(requestId: string, result: PermissionRequestResult): void {
    this.permissions.settle(requestId, result);
  }

  /**
   * Put a schema-driven question to the user.
   *
   * Like permissions, the returned promise is what the agent blocks on. With no UI to
   * ask, declining is the honest answer rather than inventing one.
   */
  private askElicitation(sessionId: string, context: ElicitationContext): Promise<ElicitationResult> {
    if (!this.onElicitationRequest) return Promise.resolve({ action: 'decline' });

    const { requestId, expiresAt, answered } = this.elicitations.add(sessionId);
    this.onElicitationRequest(sessionId, requestId, {
      kind: 'form',
      message: context.message,
      schema: (context.requestedSchema ?? null) as Record<string, unknown> | null,
      choices: [],
      mode: context.mode ?? null,
      url: context.url ?? null,
    }, expiresAt);
    return answered;
  }

  /**
   * Put a legacy ask_user question to the user.
   *
   * The CLI answers this with a single string rather than a set of fields, so the UI is
   * shown one question with the suggested choices, and freeform text stays available.
   */
  private askUserInput(sessionId: string, request: UserInputRequest): Promise<UserInputResponse> {
    if (!this.onElicitationRequest) return Promise.resolve({ answer: '', wasFreeform: true });

    const { requestId, expiresAt, answered } = this.userInputs.add(sessionId);
    this.onElicitationRequest(sessionId, requestId, {
      kind: 'input',
      message: request.question,
      schema: null,
      choices: request.choices ?? [],
      mode: null,
      url: null,
    }, expiresAt);
    return answered;
  }

  /** Apply the user's answer to a pending question, whichever variant it was. */
  resolveElicitation(
    requestId: string,
    action: ElicitationAction,
    content?: Record<string, ElicitationFieldValue>,
  ): void {
    if (requestId.startsWith('input-')) {
      const given = content?.answer;
      const answer = action === 'accept' && given !== undefined ? String(given) : '';
      // The CLI expects a string either way; an empty answer reads as "no preference".
      this.userInputs.settle(requestId, { answer, wasFreeform: true });
      return;
    }

    // Content is only meaningful on accept; sending it otherwise would imply an answer
    // the user did not give.
    const result: ElicitationResult = action === 'accept' ? { action, content } : { action };
    this.elicitations.settle(requestId, result);
  }

  /**
   * Put the agent's plan to the reader and wait for them to approve it.
   *
   * This is the checkpoint plan mode exists for, so with no UI to ask, the plan is not
   * approved. The SDK defaults the other way when no handler is registered, which meant
   * every plan was waved through unread (#167).
   */
  private askExitPlan(sessionId: string, request: ExitPlanModeRequest): Promise<ExitPlanModeResult> {
    if (!this.onPlanRequest) return Promise.resolve({ approved: false });

    const { requestId, expiresAt, answered } = this.plans.add(sessionId);
    const actions = knownPlanActions(request.actions);
    this.onPlanRequest(sessionId, requestId, {
      summary: request.summary,
      // Optional on the handler's request though the event always carries it, so the UI
      // is given the summary to show rather than an empty plan.
      planContent: request.planContent ?? request.summary,
      actions,
      recommendedAction: knownPlanAction(request.recommendedAction) ?? actions[0] ?? 'interactive',
    }, expiresAt);
    return answered;
  }

  /** Apply the reader's decision on a plan, unblocking the agent. */
  resolvePlan(requestId: string, approved: boolean, selectedAction?: PlanAction, feedback?: string): void {
    // Each half of the reply only means something on one answer: an action the reader
    // never chose would steer a plan they turned down, and feedback on approval would
    // read as a complaint about a plan they accepted.
    this.plans.settle(requestId, approved ? { approved, selectedAction } : { approved, feedback });
  }

  /** Settle every request for a session, so tearing it down cannot leave the agent hanging. */
  private abandonPending(sessionId: string): void {
    this.permissions.abandon(sessionId, { kind: 'user-not-available' });
    this.elicitations.abandon(sessionId, { action: 'cancel' });
    this.userInputs.abandon(sessionId, { answer: '', wasFreeform: true });
    this.plans.abandon(sessionId, { approved: false });
  }

  private handleEvent(sessionId: string, event: SessionEvent): void {
    const entry = this.loaded.get(sessionId);

    if (entry) {
      // `assistant.turn_end` is one model round trip, not the end of the work: a request
      // that calls tools ends and starts a turn nine times over on average, leaving a gap
      // of a few milliseconds between each. Reading those gaps as idleness meant a working
      // session could be evicted underneath itself and a typed-ahead message could be
      // spliced into the run it was meant to follow, so what counts as busy here is the
      // whole request, which is what `session.idle` marks the end of.
      if (event.type === 'assistant.turn_start') entry.busy = true;
      if (event.type === 'session.idle' || event.type === 'abort') entry.busy = false;

      // The runtime finishes writing its record of the work when the session goes idle, so
      // that is the moment the list is worth reading again - announcing the round trips
      // instead showed the panel the state before the change it was announcing.
      if (event.type === 'session.idle') this.onChangesRecorded?.(sessionId);

      // A finished turn is the first moment there is anything to write a title about, and
      // the session is idle, so asking its model a question of our own costs it nothing it
      // was about to do anyway.
      //
      // Not at `assistant.turn_start`, which is the first moment the prompt is in context
      // and would seem to be earlier: measured, a question asked mid-turn is served behind
      // the work already running and comes back as the turn ends. On a 32-second turn the
      // title arrived at 31.8 seconds, about a second before it would have anyway, and
      // paid for it with an attempt that must not move the model and so cannot title a
      // session on `auto` at all.
      if (event.type === 'session.idle') void this.titleIfUnnamed(sessionId);

      this.touch(sessionId);
    }

    // A running tool resends everything it has produced so far on every chunk, not the
    // increment its name promises, so a build writing half a megabyte would ship half a
    // megabyte down the pipe on each of its thousands of chunks. The UI shows the first
    // few thousand characters and discards the rest, so the tail is carried at quadratic
    // cost to be thrown away. Cut here, where it leaves the SDK.
    if (event.type === 'tool.execution_partial_result' && event.data.partialOutput.length > MAX_PARTIAL_OUTPUT) {
      const data = { ...event.data, partialOutput: event.data.partialOutput.slice(0, MAX_PARTIAL_OUTPUT) };
      this.onEvent?.(sessionId, { ...event, data });
      return;
    }

    this.onEvent?.(sessionId, event);
  }

  /** Mark a session most recently used and restart its idle countdown. */
  private touch(sessionId: string): void {
    const index = this.order.indexOf(sessionId);
    if (index !== -1) this.order.splice(index, 1);
    this.order.unshift(sessionId);

    this.armIdleTimer(sessionId);
  }

  /**
   * Start the countdown that releases a session nobody is using.
   *
   * A session that is working is not idle however long it has been quiet, since a shell
   * command can run for many minutes without saying anything. The countdown starts again
   * instead of evicting, so the session is released once its work ends rather than being
   * pinned in memory by a timer that already fired.
   */
  private armIdleTimer(sessionId: string): void {
    const entry = this.loaded.get(sessionId);
    if (!entry) return;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.idleTimeoutMs <= 0) return;

    entry.idleTimer = setTimeout(() => {
      if (this.loaded.get(sessionId)?.busy) {
        this.armIdleTimer(sessionId);
        return;
      }
      // A disconnect that fails is not worth crashing the sidecar over: every other session
      // would go down with it, to close one that is already beyond use.
      void this.evict(sessionId).catch(() => undefined);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref(); // Never keep the sidecar alive just to evict.
  }

  /**
   * Delete a session, or put it in the bin for as long as the reader asked for.
   *
   * Let go of here first rather than left to the CLI, which closes the session on its own
   * account: doing it through evict is what takes the session out of this runtime's books,
   * ends its subscription and tells the app it is no longer loaded. Skipping that leaves an
   * entry pointing at a session the CLI has already destroyed.
   *
   * With a retention, the session's directory is moved out of the CLI's reach rather than
   * deleted, and the CLI is not told at all: it lists sessions by reading that directory,
   * so one that has moved is one it does not have. Asking it to delete a session whose
   * directory has gone would only be asking it to fail.
   *
   * What survives either way is the row in the history database, which the CLI does not
   * remove either. The sidebar drops a row whose log has gone, so the session leaves the
   * list regardless - and comes back with its title when it is restored.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.evict(sessionId);

    if (this.binRetentionDays > 0) {
      const summary = listSessions().find((session) => session.sessionId === sessionId);
      if (binSession(sessionId, summary?.title ?? null, summary?.updatedAt ?? null)) return;
      // Nothing there to move, so there is nothing to keep and the CLI can say why.
    }

    const client = await this.ensureClient();
    await client.deleteSession(sessionId);
  }

  /** Put a binned session back where the CLI looks for it. */
  restoreSession(sessionId: string): boolean {
    return restoreSession(sessionId);
  }

  /**
   * What is waiting in the bin, with the current rules applied first.
   *
   * Swept here as well as when the rules change, so what is listed is what is kept rather
   * than what was kept under whatever the retention used to be. It also settles the order
   * of the two: shortening the retention and then reading the bin would otherwise be a
   * race between the sweep and the read, and the reader would see rows that are on their
   * way out.
   */
  binnedSessions(): BinnedSession[] {
    sweepBin(this.binRetentionDays);
    return binnedSessions();
  }

  /** Disconnect least recently used sessions until the cap is satisfied. */
  private async enforceCap(): Promise<void> {
    // Zero means the reader decides how many sessions are worth keeping, which is the
    // default. The idle timer still reclaims anything left alone.
    if (this.maxLoadedSessions <= 0) return;

    for (let i = this.order.length - 1; i >= 0 && this.order.length > this.maxLoadedSessions; i -= 1) {
      const candidate = this.order[i];
      if (!candidate) continue;
      if (this.loaded.get(candidate)?.busy) continue; // Let the turn finish first.
      await this.evict(candidate);
    }
  }

  /**
   * Change the two rules that decide what stays in memory.
   *
   * #100 asks what should happen to a setting that changes something already running, and
   * the answer is that it takes effect on what is running. A reader lowering the cap because
   * their machine is struggling means now, not next time - so sessions over the new cap are
   * released immediately, and every idle countdown is restarted to the new length rather
   * than left running to the old one.
   *
   * A busy session is still never released, which is `enforceCap`'s rule and not this one's
   * to override: the cap is about memory, and interrupting work to save some is a trade
   * nobody asked for.
   */
  async setLimits({
    maxLoadedSessions,
    idleTimeoutMs,
    binRetentionDays,
    permissionTimeoutMs,
  }: {
    maxLoadedSessions: number;
    idleTimeoutMs: number;
    binRetentionDays?: number;
    permissionTimeoutMs?: number;
  }): Promise<void> {
    this.maxLoadedSessions = Math.max(0, Math.floor(maxLoadedSessions));
    this.idleTimeoutMs = Math.max(0, Math.floor(idleTimeoutMs));
    if (binRetentionDays !== undefined) this.binRetentionDays = Math.max(0, Math.floor(binRetentionDays));
    // Read afresh for each new question, so this reaches the next one asked. What is
    // already waiting keeps the deadline it was given: the prompt on screen says when it
    // lapses, and moving that under the reader would make the countdown a lie.
    if (permissionTimeoutMs !== undefined) this.permissionTimeoutMs = Math.max(0, Math.floor(permissionTimeoutMs));

    // Here rather than on a timer of its own: the app says what the retention is as it
    // starts and whenever it changes, which is exactly when the answer to what is past it
    // can have moved. A bin is only added to by deleting, and that cannot happen unseen.
    sweepBin(this.binRetentionDays);

    // Restarted rather than left alone: a timer already counting down is counting to the
    // old length, so a reader who shortened it would wait out the old one first.
    for (const sessionId of this.loaded.keys()) this.armIdleTimer(sessionId);

    await this.enforceCap();
  }

  /**
   * Write out what the runtime is still holding for a loaded session.
   *
   * The runtime captures a turn's file changes in memory and only persists them when the
   * next turn begins, so anything reading the store straight after a turn would be one turn
   * behind. Asking for the session's rewind points is what makes it write, and costs nothing
   * for a session that is not loaded - which is every session the app has only browsed.
   */
  async flushChanges(sessionId: string): Promise<void> {
    const entry = this.loaded.get(sessionId);
    if (!entry) return;

    try {
      await entry.session.rpc.history.listRewindPoints();
    } catch {
      // Only ever a matter of freshness: the store is readable either way.
    }
  }

  /**
   * Release a session's memory while preserving it on disk.
   *
   * `disconnect()` is not destructive: the session can be resumed again later with its
   * history intact, which is what makes automatic eviction safe.
   *
   * Doing as it is told, including for a session mid-request: whether a working session
   * should be let go is a question for the caller, and the two callers that reclaim memory
   * on their own account both refuse to. Somebody asking for a session to be released has
   * already decided.
   */
  async evict(sessionId: string): Promise<void> {
    const entry = this.loaded.get(sessionId);
    if (!entry) return;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.unsubscribe();
    this.loaded.delete(sessionId);
    this.abandonPending(sessionId);

    const index = this.order.indexOf(sessionId);
    if (index !== -1) this.order.splice(index, 1);

    try {
      await entry.session.disconnect();
    } finally {
      this.onLoadedChange?.(sessionId, false);
    }
  }

  /**
   * Resume the session if needed, then send.
   *
   * A message written while a turn is running is queued rather than refused, which is what
   * the CLI does and what typing ahead is for. The decision is made here rather than by the
   * caller because this is where a turn is known to be running, and the answer comes back
   * so the caller knows whether the message is in the conversation yet or still waiting.
   */
  async send(
    sessionId: string,
    prompt: string,
    mode?: 'enqueue' | 'immediate',
    attachments?: Attachment[],
  ): Promise<{ messageId: string; queued: boolean }> {
    const session = await this.ensureSession(sessionId);
    const queued = mode ? mode === 'enqueue' : (this.loaded.get(sessionId)?.busy ?? false);

    // Kept so the turn's own record can name the prompt that caused it, which is what makes
    // a rewind point recognisable rather than a timestamp.
    const entry = this.loaded.get(sessionId);
    if (entry) entry.lastPrompt = prompt;

    const messageId = await session.send({
      prompt,
      mode: queued ? 'enqueue' : 'immediate',
      // Passed straight through: the runtime reads the files, so nothing here needs to
      // open them, and a path is all it wants.
      ...(attachments?.length ? { attachments } : {}),
    });

    // The work starts here rather than at the first `assistant.turn_start`, so that nothing
    // in the moment before the runtime announces the turn can evict the session or mistake
    // a second message for an interruption.
    if (entry) entry.busy = true;

    return { messageId, queued };
  }

  /**
   * The slash commands there are.
   *
   * A loaded session is asked in preference to the runtime at large, because it knows about
   * a few more: the ones that only mean anything inside a conversation, such as /compact and
   * /context. A cold session is deliberately not resumed for this - browsing what a command
   * does should never cost what running one does - so it falls back to the general list,
   * which is four commands shorter and otherwise identical.
   *
   * Either way this needs the shared server, so it is asked for when someone opens the list
   * rather than in anticipation of them doing so. The frontend remembers the answer between
   * runs, which is what keeps the first slash from being the thing that starts a process.
   */
  async commands(sessionId?: string): Promise<SlashCommand[]> {
    const live = sessionId ? this.loaded.get(sessionId)?.session : undefined;
    const client = live ? null : await this.ensureClient();
    const { commands } = live ? await live.rpc.commands.list() : await client!.rpc.commands.list();

    return commands.map((command) => ({
      name: command.name,
      description: command.description,
      aliases: command.aliases ?? [],
      ...(command.input?.hint ? { hint: command.input.hint } : {}),
      ...(command.input?.required ? { required: true } : {}),
      ...(command.input?.completion ? { completion: command.input.completion } : {}),
      ...(command.input?.choices?.length
        ? { choices: command.input.choices.map(({ name, description }) => ({ name, description })) }
        : {}),
      allowDuringTurn: command.allowDuringAgentExecution,
      ...(command.experimental ? { experimental: true } : {}),
    }));
  }

  /**
   * Put a session on a custom agent, or back on the default when no name is given.
   *
   * Resumes a cold session, as setting a model does. Browsing is where the saving belongs and
   * it is already free; choosing is an act on one particular conversation, and nobody chooses
   * an agent except immediately before using it.
   */
  async selectAgent(sessionId: string, name: string | null): Promise<void> {
    const session = await this.ensureSession(sessionId);

    if (name === null) await session.rpc.agent.deselect();
    else await session.rpc.agent.select({ name });
  }

  /**
   * Switch a skill on or off for one session.
   *
   * Costs no resume. The choice is this app's to keep, and a cold session picks it up when
   * it is next started; only a session already loaded needs telling, and that one is told
   * through `options.update` rather than the runtime's own `skills.disable`, because that
   * one is forgotten on the next resume while this is re-applied on every one.
   */
  async setSkillEnabled(sessionId: string, name: string, enabled: boolean): Promise<string[]> {
    const disabled = setSkillDisabled(sessionId, name, !enabled);

    const loaded = this.loaded.get(sessionId);
    if (loaded) await loaded.session.rpc.options.update({ disabledSkills: disabled });

    return disabled;
  }

  /** The skills this session has switched off, whether or not it is loaded. */
  disabledSkills(sessionId: string): string[] {
    return disabledSkills(sessionId);
  }

  /**
   * What a session has waiting behind the turn it is running.
   *
   * Read from the runtime rather than tracked here. This app used to keep its own list,
   * on the belief that the runtime offered no way to ask - it does, and a second copy of
   * a queue can only ever disagree with the first. The runtime's also holds things this
   * app never put there: commands queued during a turn, model changes, and messages sent
   * from a terminal attached to the same session.
   *
   * A session that is not loaded has no queue, and asking must not be what loads it: the
   * sidebar asks about every session, and resuming each one to be told it has nothing
   * waiting is the cost this app exists to avoid.
   */
  async queue(sessionId: string): Promise<QueuedItem[]> {
    const live = this.loaded.get(sessionId)?.session;
    if (!live) return [];

    const { items } = await live.rpc.queue.pendingItems();
    return items.map((item) => ({
      id: item.id,
      kind: item.kind === 'message' ? 'message' : item.kind === 'command' ? 'command' : 'other',
      text: stripAnsi(item.displayText),
      ...(item.messageId ? { messageId: item.messageId } : {}),
    }));
  }

  /**
   * How much of a loaded session's context window is spoken for.
   *
   * Asked of the runtime rather than reconstructed here, because the count depends on the
   * tokeniser of the model actually resolved - which under `Auto` is not the model the log
   * names - and on tool definitions that vary with what is installed. This is the same
   * breakdown `/context` prints.
   *
   * Null for a session that is not loaded, for the same reason the queue is empty for one:
   * the numbers live in the running session and nowhere on disk, and resuming a session to
   * find out how full it is would cost exactly what this app exists to avoid. Also null for
   * a session that is loaded but has not yet built its system prompt, which the runtime
   * reports by answering with a null attribution rather than an error.
   */
  async contextUsage(sessionId: string): Promise<SessionContextUsage | null> {
    const live = this.loaded.get(sessionId)?.session;
    if (!live) return null;

    const { contextAttribution: found } = await live.rpc.metadata.getContextAttribution();
    if (!found) return null;

    return {
      totalTokens: found.totalTokens,
      promptTokenLimit: found.promptTokenLimit,
      compactionThreshold: found.compactionThreshold,
      categories: {
        systemPrompt: found.categories.systemPrompt,
        customInstructions: found.categories.customInstructions,
        systemTools: found.categories.systemTools,
        mcpTools: found.categories.mcpTools,
        messages: found.categories.messages,
        freeSpace: found.categories.freeSpace,
      },
      compactions: found.compactions.count,
    };
  }

  /**
   * What a session has spent, without starting one to find out.
   *
   * A loaded session is asked directly, because only it can account for tokens, requests
   * and the code the agent changed. A cold one is read from the last usage checkpoint in
   * its log, which carries the two running totals and is exact for them: a resumed session
   * reports the same numbers, rebuilt from that same checkpoint.
   *
   * So this answers for a session the app has never opened, which is the difference from
   * `contextUsage` - a window only exists while a session is loaded, but what it has
   * already cost is a fact about its past and is written down.
   *
   * `totalUserRequests` and the last call's token counts are deliberately not carried.
   * Both read zero on every resumed session measured, so passing them on would report a
   * busy session as having made no requests.
   */
  async usage(sessionId: string): Promise<SessionUsage | null> {
    const live = this.loaded.get(sessionId)?.session;
    if (!live) return lastUsage(sessionId);

    const found = await live.rpc.usage.getMetrics();
    const models = Object.entries(found.modelMetrics ?? {})
      .flatMap(([model, metric]) => (metric ? [{ model, requests: metric.requests.count, cost: metric.requests.cost }] : []))
      .sort((a, b) => b.cost - a.cost);

    const totals = Object.values(found.modelMetrics ?? {}).reduce(
      (sum, metric) => ({
        input: sum.input + (metric?.usage.inputTokens ?? 0),
        output: sum.output + (metric?.usage.outputTokens ?? 0),
        cacheRead: sum.cacheRead + (metric?.usage.cacheReadTokens ?? 0),
        cacheWrite: sum.cacheWrite + (metric?.usage.cacheWriteTokens ?? 0),
        reasoning: sum.reasoning + (metric?.usage.reasoningTokens ?? 0),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    );

    return {
      premiumRequests: found.totalPremiumRequestCost,
      aiu: (found.totalNanoAiu ?? 0) / 1e9,
      loaded: true,
      tokens: totals,
      requests: models.reduce((sum, model) => sum + model.requests, 0),
      apiDurationMs: found.totalApiDurationMs,
      ...(found.sessionStartTime ? { startedAt: found.sessionStartTime } : {}),
      codeChanges: {
        linesAdded: found.codeChanges.linesAdded,
        linesRemoved: found.codeChanges.linesRemoved,
        filesModified: found.codeChanges.filesModifiedCount,
      },
      models,
    };
  }

  /**
   * What each MCP server is actually doing in one session.
   *
   * The configured list says what a directory would be offered. This says what happened
   * when it was tried, which is the question a reader opens the panel with and the one
   * nothing could answer: a server that is configured, enabled and quietly failing looked
   * exactly like one that was working (#24).
   *
   * Null for a session that is not loaded, and no session is ever resumed to answer.
   * Connection state is something a reader would like to see rather than something they
   * asked for, and this app does not start a process for that - the same rule `usage`
   * follows, and the one this repository is built on.
   */
  async mcpStatus(sessionId: string): Promise<McpServerState[] | null> {
    const live = this.loaded.get(sessionId)?.session;
    if (!live) return null;

    const { servers } = await live.rpc.mcp.list();
    return (servers ?? []).map((server) => ({
      name: server.name,
      status: server.status,
      ...(server.error ? { error: server.error } : {}),
    }));
  }

  /**
   * Begin signing in to a server that is waiting for it.
   *
   * Answers with the page to send the reader to, and nothing else: the runtime holds the
   * other end of the exchange, and says how it went through `session.mcp_oauth_completed`
   * rather than by returning.
   *
   * Needs a loaded session, and this one may resume to get it - unlike reading the status.
   * Signing in is something a reader asked for by pressing a button, which is exactly the
   * case the rule allows a resume for.
   */
  async mcpLogin(sessionId: string, name: string): Promise<string | null> {
    const session = await this.ensureSession(sessionId);
    const { authorizationUrl } = await session.rpc.mcp.oauth.login({ serverName: name });
    return authorizationUrl ?? null;
  }

  /**
   * Put a slash command in the queue behind the running turn.
   *
   * The runtime runs it itself when the queue drains: it emits no request for the host to
   * run one, which was the open question in #147. Verified by enqueuing `/compact` during
   * a turn - `pending_messages.modified` fires on the way in and again as it drains, and
   * no `command.queued` ever arrives.
   *
   * `queued: false` means the session does not queue locally, which is the one case a
   * caller has to handle rather than assume.
   */
  async enqueue(sessionId: string, command: string, displayText?: string): Promise<boolean> {
    const session = await this.ensureSession(sessionId);
    const { queued } = await session.rpc.commands.enqueue({
      command,
      ...(displayText ? { displayText } : {}),
    });
    return queued;
  }

  /**
   * Run a slash command in a session.
   *
   * Unlike a message this returns its result rather than emitting it: nothing about a
   * command reaches the event log, so what it produced is only ever known here, and only
   * once. The caller has to show it, because nothing will show it again.
   *
   * Costs a resume for a cold session, which is the same price as sending to it - running
   * a command in a conversation is working in that conversation.
   */
  async invoke(sessionId: string, name: string, input?: string): Promise<CommandOutcome> {
    const session = await this.ensureSession(sessionId);
    const result = await session.rpc.commands.invoke({ name, ...(input ? { input } : {}) });

    /**
     * Read before the switch, because the runtime attaches it to every kind of result.
     *
     * Reading it per branch is how it came to be dropped in the first place: it was looked
     * for on `completed` alone, where the issue happened to notice it, while `text`,
     * `agent-prompt` and `add-timeline-entry` carry it too. Taken from the result rather
     * than from a narrowed type, so a kind this build does not model still reports it.
     */
    const changed =
      'runtimeSettingsChanged' in result && result.runtimeSettingsChanged === true
        ? { settingsChanged: true as const }
        : {};

    /**
     * Apply a mode the command reported, whichever kind reported it.
     *
     * The runtime says what the host is to become, it does not become it (#167). That was
     * fixed for `completed` and left undone for `agent-prompt`, which carries the same
     * field for the same reason - a command that switches the mode and then writes a prompt
     * would have sent the prompt in the mode it was already in.
     */
    const applyMode = async (mode: SessionMode | undefined) => {
      if (mode) await session.rpc.mode.set({ mode });
    };

    switch (result.kind) {
      case 'text':
        // Terminal escapes are asked for by commands that expect a terminal. This is not
        // one, and leaving them in would print their letters rather than their colours.
        return {
          kind: 'text',
          text: stripAnsi(result.text),
          ...(result.markdown ? { markdown: true } : {}),
          ...changed,
        };

      case 'agent-prompt':
        // The prompt the command wrote is what the agent is given. Its display form is
        // dropped: the transcript already carries the command that produced it, which is
        // the record of what was asked for.
        await applyMode(result.mode);

        return {
          kind: 'prompt',
          prompt: result.prompt,
          ...(result.notice ? { notice: result.notice } : {}),
          ...changed,
        };

      case 'completed': {
        // `/autopilot` and `/interactive` do not switch the mode themselves. They report
        // the mode the host is then to apply, and dropping that meant both commands ran,
        // reported themselves completed, and left the session in the mode it started in -
        // a command that silently did nothing, which is the one outcome the default branch
        // below exists to avoid (#167).
        //
        // `/plan` is not one of these, whatever its name suggests: it is a prompt command
        // that prefixes the message with `[[PLAN]]` and has the agent write a plan.md. It
        // reports no mode and never enters plan mode.
        await applyMode(result.mode);

        return {
          kind: 'done',
          ...(result.message ? { message: result.message } : {}),
          ...(result.mode ? { mode: result.mode } : {}),
          ...changed,
        };
      }

      // Not output so much as a row the runtime wants added, but the difference does not
      // survive into anything this app draws.
      case 'add-timeline-entry':
        return { kind: 'text', text: stripAnsi(result.entry.text), ...changed };

      // Sub-command pickers, model dialogues and the rest ask the client to run a piece of
      // its own interface. Named rather than swallowed, so an unsupported one reads as
      // missing rather than as a command that silently did nothing.
      default:
        return { kind: 'unsupported', what: result.kind, ...changed };
    }
  }

  /**
   * How a session is working, without loading it to find out.
   *
   * A loaded session is asked, since it holds the truth; a cold one is read from its log,
   * which is what keeps the sidebar from resuming every session just to label it. The two
   * can disagree only while a change is in flight, and the runtime's answer wins as soon
   * as the session is loaded.
   */
  async mode(sessionId: string): Promise<SessionMode> {
    const live = this.loaded.get(sessionId)?.session;
    if (!live) return lastMode(sessionId);

    return live.rpc.mode.get();
  }

  /**
   * Put a session into a mode, from its next message onwards.
   *
   * Costs a resume, because a mode belongs to the running session rather than to anything
   * on disk. That is the same price as sending to it, and unlike the sidebar's labelling
   * this is something the reader asked for outright.
   *
   * The mode is read back rather than assumed: a switch can be refused, or be held up
   * waiting on a confirmation this app does not yet answer, and reporting the request as
   * though it took would leave the reader looking at a mode the session is not in.
   *
   * Switching can also change the model, since plan mode can have one of its own. The
   * runtime says so in prose, which is passed on rather than dropped - a model changing
   * underneath the reader is not something to discover later.
   */
  async setMode(sessionId: string, mode: SessionMode): Promise<{ mode: SessionMode; notice?: string }> {
    const session = await this.ensureSession(sessionId);
    const result = await session.rpc.mode.set({ mode });

    const notice = result.warning ?? result.message;
    return {
      mode: await session.rpc.mode.get(),
      ...(notice ? { notice: stripAnsi(notice) } : {}),
    };
  }

  /**
   * Change the model a session uses, from its next message onwards.
   *
   * Write a title for a session that is still wearing its first prompt as a name.
   *
   * The runtime names a new session with the prompt it was given, whole and verbatim, and
   * replaces it with nothing: every session this app has made still has `summary_count: 0`,
   * and one carried a 303-character name. The CLI does not have this problem because it
   * writes a title itself and hands it over. So does this now (#197).
   *
   * Tried once, when the session goes idle after a turn. The answer is set as a name that
   * nobody chose, so the runtime is still free to replace it later and a rename still
   * outranks it.
   *
   * Failure is silence. A session keeping the name it had is the situation this improves on,
   * not a fault, and nothing here is worth interrupting a reader over.
   */
  private async titleIfUnnamed(sessionId: string): Promise<void> {
    // Once per session per run, whatever the outcome: a session that could not be titled
    // after its first turn will be no easier after its twentieth, and asking again on every
    // idle would spend a model call each time.
    if (this.titled.has(sessionId)) return;
    this.titled.add(sessionId);

    const entry = this.loaded.get(sessionId);
    const prompt = entry?.lastPrompt;
    if (!entry || !prompt) return;

    const { name, named } = nameState(sessionId);
    if (!isPlaceholder(name, prompt, named)) return;

    try {
      const answer = await this.askForTitle(entry.session);
      const title = answer === null ? null : titleIn(answer);
      if (!title) return;

      await entry.session.rpc.name.setAuto({ summary: title });
      // The sidebar reads the name from the file, so it has to be told to look again.
      this.onChangesRecorded?.(sessionId);
    } catch {
      // Nothing here is worth telling anyone about: the session keeps the name it had.
    }
  }

  /**
   * Put the title question to a session's model, moving it off `auto` only if it has to.
   *
   * Asked as it stands first, so a session on a named model is never moved at all. `auto` is
   * the only model that cannot answer - the inference comes back as "the requested model is
   * not supported" - and it is the default, so the fallback is the path most sessions take
   * rather than an edge case. Which is why the restore is in a `finally`.
   *
   * Safe to move it here because the session is idle: doing the same mid-turn would run part
   * of somebody's turn on a model they did not choose.
   */
  private async askForTitle(session: CopilotSession): Promise<string | null> {
    try {
      return (await session.rpc.ui.ephemeralQuery({ question: TITLE_QUESTION })).answer;
    } catch {
      // Falls through to asking on a model that can answer.
    }

    const was = (await session.rpc.model.getCurrent()).modelId;
    const able = await this.modelForTitling();
    if (!able || able === was) return null;

    try {
      await session.setModel(able);
      return (await session.rpc.ui.ephemeralQuery({ question: TITLE_QUESTION })).answer;
    } finally {
      // Back where it was, whatever happened. Being left on a model nobody chose is worse
      // than having no title.
      if (was) await session.setModel(was).catch(() => undefined);
    }
  }

  /**
   * A model that can answer a question about a conversation, preferring a small one.
   *
   * The title is four words about a prompt that has already been read, so the cheapest
   * model that exists is the right one. The preferences are matched loosely because model
   * names change faster than this app does; anything named at all will do if none matches.
   */
  private async modelForTitling(): Promise<string | null> {
    if (this.titlingModel !== undefined) return this.titlingModel;

    try {
      const client = await this.ensureClient();
      const ids = (await client.listModels()).map((model) => model.id).filter((id) => id !== 'auto');
      const cheap = ids.find((id) => /haiku|mini|flash|fast|small/i.test(id));
      this.titlingModel = cheap ?? ids[0] ?? null;
    } catch {
      this.titlingModel = null;
    }

    return this.titlingModel;
  }

  /**
   * The session has to be loaded for this, since the choice belongs to the running session
   * rather than to anything on disk. That makes choosing a model for a cold session cost a
   * resume, which is the same price as sending to it.
   */
  async setModel(
    sessionId: string,
    model: string,
    reasoningEffort?: ReasoningEffort,
    contextTier?: ContextTier,
  ): Promise<void> {
    const session = await this.ensureSession(sessionId);
    await session.setModel(model, {
      // Cast because the SDK's own union omits "none", which several models nonetheless
      // report as a level they accept.
      ...(reasoningEffort ? { reasoningEffort: reasoningEffort as never } : {}),
      ...(contextTier ? { contextTier } : {}),
    });
  }

  /**
   * Run a shell command the reader asked for, in the session's own shell.
   *
   * Not `execFile` here: going through the runtime means the command is emitted as a tool
   * call into the session, so its output lands in the event log, persists across restarts,
   * and is in the agent's context afterwards. That last part is the point - `!git status`
   * is worth having because the agent can then be asked about what it printed. A command
   * run beside the session would give none of that (#134).
   *
   * The shell is the session's, which is PowerShell on Windows and bash elsewhere. Forcing
   * a different one would hand the reader a different environment from the agent's.
   *
   * `requestId` is ours to choose and is the handle `cancelShell` needs, so the caller has
   * to supply one it kept.
   */
  async shell(sessionId: string, requestId: string, command: string): Promise<ShellResult> {
    const session = await this.ensureSession(sessionId);
    const result = await session.rpc.shell.executeUserRequested({ requestId, command });

    return {
      success: result.success,
      // The session's shell is a real terminal as far as the command is concerned, so its
      // output carries colour sequences. This app draws HTML, where they read as letters.
      output: stripAnsi(result.output),
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      ...(result.error ? { error: stripAnsi(result.error) } : {}),
    };
  }

  /**
   * Stop a shell command started by `shell`.
   *
   * Separate from `abort`: a shell command is not the agent's turn, and stopping one should
   * not stop the other.
   */
  async cancelShell(sessionId: string, requestId: string): Promise<void> {
    const entry = this.loaded.get(sessionId);
    // Nothing to cancel in a session that is not loaded, and resuming one to say so would
    // start a process to address a command that cannot be running.
    if (!entry) return;

    await entry.session.rpc.shell.cancelUserRequested({ requestId });
  }

  /** Stop the current turn without unloading the session. */
  async abort(sessionId: string): Promise<void> {
    // Anything waiting on the user belongs to the turn being stopped, so settle it too;
    // otherwise the promise the agent is blocked on would never resolve.
    this.abandonPending(sessionId);

    const entry = this.loaded.get(sessionId);
    // Stopped work is not work: a session left marked busy would never be released.
    if (entry) entry.busy = false;

    await entry?.session.abort();
  }

  /** Release every session and stop the shared server. */
  async shutdown(): Promise<void> {
    for (const sessionId of [...this.order]) {
      await this.evict(sessionId).catch(() => undefined);
    }

    const client = this.client;
    this.client = null;
    this.discovery.forget();
    if (client) await client.stop().catch(() => undefined);
  }
}
