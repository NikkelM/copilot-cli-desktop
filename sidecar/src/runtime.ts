import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type ElicitationContext,
  type ElicitationResult,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from '@github/copilot-sdk';

import type {
  Attachment,
  CommandOutcome,
  ContextTier,
  ElicitationAction,
  ElicitationFieldValue,
  ModelChoice,
  PermissionChoice,
  ReasoningEffort,
  SlashCommand,
} from '../../shared/protocol.js';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { resolveCliPath } from './paths.js';
import { beginTurn, endTurn, noteToolEnd, noteToolStart, pathOf, shouldRecord } from './rewindCapture.js';

/**
 * Remove terminal colour and cursor sequences from command output.
 *
 * Commands that expect a terminal write them unasked, and this app draws HTML: left in,
 * the escape would appear as its own characters in the middle of the text it was meant to
 * colour. Matches the CSI and OSC forms, which is everything the CLI's own output uses.
 */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '');
}

import { PendingRequests } from './pending.js';

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
  /** What the turn in progress has changed, in the CLI's rewind format. Null when idle. */
  turn?: ReturnType<typeof beginTurn> | null;
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
  /** Notifies that a session's loaded state changed, so the sidebar can update. */
  onLoadedChange?: (sessionId: string, loaded: boolean) => void;
  /** Asks the UI to approve or deny a tool call. */
  onPermissionRequest?: (sessionId: string, requestId: string, request: PermissionRequest) => void;
  /** Tells the UI a pending request is no longer awaiting an answer. */
  onPermissionResolved?: (sessionId: string, requestId: string) => void;
  /** Asks the UI to put a question from the agent to the user. */
  onElicitationRequest?: (sessionId: string, requestId: string, context: AskContext) => void;
  /** Tells the UI a question is no longer awaiting an answer. */
  onElicitationResolved?: (requestId: string) => void;
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

  private readonly loaded = new Map<string, LoadedSession>();
  /** In-flight resumes, so concurrent sends to one session resume it once. */
  private readonly resuming = new Map<string, Promise<CopilotSession>>();
  /** Session IDs currently resumed, ordered most-recently-used first. */
  private readonly order: string[] = [];

  private readonly maxLoadedSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly onEvent?: (sessionId: string, event: SessionEvent) => void;
  private readonly onLoadedChange?: (sessionId: string, loaded: boolean) => void;
  private readonly onPermissionRequest?: (
    sessionId: string,
    requestId: string,
    request: PermissionRequest,
  ) => void;
  private readonly onPermissionResolved?: (sessionId: string, requestId: string) => void;
  private readonly onElicitationRequest?: (
    sessionId: string,
    requestId: string,
    context: AskContext,
  ) => void;
  private readonly onElicitationResolved?: (requestId: string) => void;
  private readonly createClient: () => Promise<CopilotClient>;

  /** Tool calls waiting on an approve or deny decision. */
  private readonly permissions: PendingRequests<PermissionRequestResult>;
  /** Schema-driven questions waiting on an answer. */
  private readonly elicitations: PendingRequests<ElicitationResult>;
  /** Legacy ask_user questions waiting on an answer. */
  private readonly userInputs: PendingRequests<UserInputResponse>;

  constructor(options: RuntimeOptions = {}) {
    this.maxLoadedSessions = options.maxLoadedSessions ?? 0;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.onEvent = options.onEvent;
    this.onLoadedChange = options.onLoadedChange;
    this.onPermissionRequest = options.onPermissionRequest;
    this.onPermissionResolved = options.onPermissionResolved;
    this.onElicitationRequest = options.onElicitationRequest;
    this.onElicitationResolved = options.onElicitationResolved;
    this.createClient = options.createClient ?? defaultClientFactory;

    const timeout = options.permissionTimeoutMs ?? 5 * 60_000;
    this.permissions = new PendingRequests<PermissionRequestResult>('perm', timeout, () => ({
      kind: 'user-not-available',
    }));
    // Giving up on a question is a decline: the agent asked and nobody answered.
    this.elicitations = new PendingRequests<ElicitationResult>('elicit', timeout, () => ({
      action: 'decline',
    }));
    this.userInputs = new PendingRequests<UserInputResponse>('input', timeout, () => ({
      answer: '',
      wasFreeform: true,
    }));
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
  async create(workingDirectory?: string): Promise<{ sessionId: string }> {
    const client = await this.ensureClient();

    // The handlers need the session's id, which does not exist until it does, so they
    // read it when called rather than closing over a value that is not there yet.
    let id = '';
    const session = await client.createSession({
      workingDirectory: workingDirectory ?? homedir(),
      onPermissionRequest: (request) => this.decidePermission(id, request),
      onUserInputRequest: (request) => this.askUserInput(id, request),
      onElicitationRequest: (context) => this.askElicitation(id, context),
      streaming: true,
    });

    id = session.sessionId;
    this.adopt(id, session);
    await this.enforceCap();
    return { sessionId: id };
  }

  /** Resume a session if it is not already loaded, evicting another if needed. */
  private async ensureSession(sessionId: string): Promise<CopilotSession> {    const existing = this.loaded.get(sessionId);
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
      onPermissionRequest: (request) => this.decidePermission(sessionId, request),
      // The CLI picks one of two ask_user variants per session, so both are handled.
      // The legacy one arrives here as a user input request.
      onUserInputRequest: (request) => this.askUserInput(sessionId, request),
      onElicitationRequest: (context) => this.askElicitation(sessionId, context),
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
    this.onLoadedChange?.(sessionId, true);
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

    const { requestId, answered } = this.permissions.add(sessionId);
    this.onPermissionRequest(sessionId, requestId, request);
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
    const sessionId = this.permissions.settle(requestId, result);
    if (sessionId) this.onPermissionResolved?.(sessionId, requestId);
  }

  /**
   * Put a schema-driven question to the user.
   *
   * Like permissions, the returned promise is what the agent blocks on. With no UI to
   * ask, declining is the honest answer rather than inventing one.
   */
  private askElicitation(sessionId: string, context: ElicitationContext): Promise<ElicitationResult> {
    if (!this.onElicitationRequest) return Promise.resolve({ action: 'decline' });

    const { requestId, answered } = this.elicitations.add(sessionId);
    this.onElicitationRequest(sessionId, requestId, {
      kind: 'form',
      message: context.message,
      schema: (context.requestedSchema ?? null) as Record<string, unknown> | null,
      choices: [],
      mode: context.mode ?? null,
      url: context.url ?? null,
    });
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

    const { requestId, answered } = this.userInputs.add(sessionId);
    this.onElicitationRequest(sessionId, requestId, {
      kind: 'input',
      message: request.question,
      schema: null,
      choices: request.choices ?? [],
      mode: null,
      url: null,
    });
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
      if (this.userInputs.settle(requestId, { answer, wasFreeform: true })) {
        this.onElicitationResolved?.(requestId);
      }
      return;
    }

    // Content is only meaningful on accept; sending it otherwise would imply an answer
    // the user did not give.
    const result: ElicitationResult = action === 'accept' ? { action, content } : { action };
    if (this.elicitations.settle(requestId, result)) this.onElicitationResolved?.(requestId);
  }

  /** Settle every request for a session, so tearing it down cannot leave the agent hanging. */
  private abandonPending(sessionId: string): void {
    for (const requestId of this.permissions.abandon(sessionId, { kind: 'user-not-available' })) {
      this.onPermissionResolved?.(sessionId, requestId);
    }
    for (const requestId of this.elicitations.abandon(sessionId, { action: 'cancel' })) {
      this.onElicitationResolved?.(requestId);
    }
    for (const requestId of this.userInputs.abandon(sessionId, { answer: '', wasFreeform: true })) {
      this.onElicitationResolved?.(requestId);
    }
  }

  private handleEvent(sessionId: string, event: SessionEvent): void {
    const entry = this.loaded.get(sessionId);

    if (entry) {
      // Track turn boundaries so a session mid-turn is never evicted underneath itself.
      if (event.type === 'assistant.turn_start') {
        entry.busy = true;

        // The CLI records every turn it runs in the session's own rewind store, and a turn
        // driven through the SDK records nothing - so this app writes the same format in the
        // same place, and the two can see each other's work.
        entry.turn = shouldRecord(sessionId)
          ? beginTurn(event.id ?? randomUUID(), entry.lastPrompt ?? '')
          : null;
      }

      this.captureFileChange(entry, event);

      if (event.type === 'session.idle' || event.type === 'assistant.turn_end') {
        entry.busy = false;
        if (entry.turn) {
          try {
            endTurn(sessionId, entry.turn);
          } catch {
            // A turn is not worth failing over something written for its own history.
          }
          entry.turn = null;
        }
      }

      this.touch(sessionId);
    }

    this.onEvent?.(sessionId, event);
  }

  /**
   * Follow a tool call that changes a file, so the turn's record has both versions.
   *
   * Read at the tool's start and again at its finish, rather than comparing the whole tree
   * at each end of the turn: that is what the git mechanism did, and it is why it needed a
   * repository to be affordable.
   */
  private captureFileChange(entry: LoadedSession, event: SessionEvent): void {
    if (!entry.turn) return;

    const data = event.data as { toolCallId?: string; toolName?: string; arguments?: unknown } | undefined;
    const callId = data?.toolCallId;
    if (!callId) return;

    if (event.type === 'tool.execution_start') {
      const path = pathOf(data?.toolName, data?.arguments);
      if (path) noteToolStart(entry.turn, callId, path);
    } else if (event.type === 'tool.execution_complete') {
      noteToolEnd(entry.turn, callId);
    }
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

    return {
      messageId: await session.send({
        prompt,
        mode: queued ? 'enqueue' : 'immediate',
        // Passed straight through: the runtime reads the files, so nothing here needs to
        // open them, and a path is all it wants.
        ...(attachments?.length ? { attachments } : {}),
      }),
      queued,
    };
  }

  /**
   * The models this account may use.
   *
   * Listing them needs the shared server, so this is the one read that costs a process.
   * Asked for when a reader opens the picker rather than at startup, and answered from the
   * server's own cache after that.
   *
   * Trimmed here rather than in the UI: what the runtime reports carries context limits and
   * token pricing tables that nothing shows, and the protocol is better off narrow.
   */
  async models(): Promise<ModelChoice[]> {
    const client = await this.ensureClient();

    return (await client.listModels()).map((model) => {
      const prices = model.billing?.tokenPrices;
      // Prices are quoted per billing batch, and a batch is not a million tokens for every
      // model, so they are converted here rather than left for the UI to get wrong.
      const perMillion = (value?: number) =>
        value === undefined ? undefined : value * (1_000_000 / (prices?.batchSize || 1_000_000));

      return {
        id: model.id,
        name: model.name,
        reasoningEfforts: (model.supportedReasoningEfforts ?? []) as ReasoningEffort[],
        defaultReasoningEffort: model.defaultReasoningEffort as ReasoningEffort | undefined,
        // The sizes a model runs at are described by what each is priced for, which is also
        // the only place the larger one is mentioned. Some models are priced without saying
        // how much they take, and for those the model's own prompt limit is the answer.
        contexts: [
          ...(prices?.maxPromptTokens || model.capabilities?.limits?.max_prompt_tokens
            ? [
                {
                  tier: 'default' as const,
                  maxPromptTokens: prices?.maxPromptTokens ?? model.capabilities.limits.max_prompt_tokens!,
                },
              ]
            : []),
          ...(prices?.longContext?.maxPromptTokens
            ? [{ tier: 'long_context' as const, maxPromptTokens: prices.longContext.maxPromptTokens }]
            : []),
        ],
        prices: prices && {
          input: perMillion(prices.inputPrice),
          cachedInput: perMillion(prices.cacheReadPrice ?? prices.cachePrice),
          output: perMillion(prices.outputPrice),
        },
        // Listed but unusable until its terms are accepted, which happens outside this app.
        needsAgreement: model.policy?.state === 'unconfigured',
      };
    });
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
      ...(command.input?.choices?.length
        ? { choices: command.input.choices.map(({ name, description }) => ({ name, description })) }
        : {}),
      allowDuringTurn: command.allowDuringAgentExecution,
      ...(command.experimental ? { experimental: true } : {}),
    }));
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

    switch (result.kind) {
      case 'text':
        // Terminal escapes are asked for by commands that expect a terminal. This is not
        // one, and leaving them in would print their letters rather than their colours.
        return { kind: 'text', text: stripAnsi(result.text), ...(result.markdown ? { markdown: true } : {}) };

      case 'agent-prompt':
        // The prompt the command wrote is what the agent is given. Its display form is
        // dropped: the transcript already carries the command that produced it, which is
        // the record of what was asked for.
        return {
          kind: 'prompt',
          prompt: result.prompt,
          ...(result.notice ? { notice: result.notice } : {}),
        };

      case 'completed':
        return { kind: 'done', ...(result.message ? { message: result.message } : {}) };

      // Not output so much as a row the runtime wants added, but the difference does not
      // survive into anything this app draws.
      case 'add-timeline-entry':
        return { kind: 'text', text: stripAnsi(result.entry.text) };

      // Sub-command pickers, model dialogues and the rest ask the client to run a piece of
      // its own interface. Named rather than swallowed, so an unsupported one reads as
      // missing rather than as a command that silently did nothing.
      default:
        return { kind: 'unsupported', what: result.kind };
    }
  }

  /**
   * Change the model a session uses, from its next message onwards.
   *
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

  /** Stop the current turn without unloading the session. */
  async abort(sessionId: string): Promise<void> {
    // Anything waiting on the user belongs to the turn being stopped, so settle it too;
    // otherwise the promise the agent is blocked on would never resolve.
    this.abandonPending(sessionId);
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
