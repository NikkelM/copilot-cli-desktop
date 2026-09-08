/**
 * Wire protocol shared between the Tauri shell, the React frontend and the Node sidecar.
 * Kept dependency-free so both tsconfigs can include it directly.
 */

/** A session as shown in the sidebar. Sourced from session-store.db - never requires a running CLI process. */
export interface SessionSummary {
  sessionId: string;
  /** Generated or user-set session name. */
  title: string | null;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  /** ISO-8601. Sidebar sorts by this descending. */
  updatedAt: string;
  createdAt: string;
  /** Truncated tail of the last user or assistant message. */
  preview: string | null;
  /** Whether a live runtime session is currently held in memory. */
  loaded: boolean;
}

/** Lifecycle of a session inside the sidecar runtime. Only `active` holds meaningful memory. */
export type SessionRuntimeState =
  | 'cold' // never loaded in this app run; history is read straight from disk
  | 'loading' // resumeSession() in flight
  | 'active' // loaded in the shared CLI server process
  | 'evicted'; // was active, then disconnected to reclaim memory

/**
 * A single entry in a session's transcript.
 * Deliberately mirrors the SDK's SessionEvent shape so replayed history from
 * events.jsonl and live streamed events render through identical code paths.
 */
export interface TranscriptEvent {
  type: string;
  data: unknown;
  /**
   * The session's own identifier for the event, stable across replays and pages.
   * Absent only on events the app itself invents, such as an optimistic prompt.
   */
  id?: string;
  /** When the runtime recorded it. Present on live events as well as replayed ones. */
  timestamp?: string;
}

export interface ListSessionsResult {
  sessions: SessionSummary[];
}

export interface GetTranscriptParams {
  sessionId: string;
  /** Cap on returned events; the newest are kept. Guards against multi-MB logs. */
  limit?: number;
  /** Byte offset to read back from, taken from a previous result's `nextBefore`. */
  before?: number;
}

export interface GetTranscriptResult {
  events: TranscriptEvent[];
  /** True when older events exist before the ones returned. */
  truncated: boolean;
  /**
   * Cursor for fetching the page before this one, or null at the start of the log.
   * A byte offset into events.jsonl, pointing at the first event returned here.
   */
  nextBefore: number | null;
}

export interface RuntimeStatus {
  /** Whether the shared CLI server process is running. */
  serverRunning: boolean;
  /** Sessions currently held in memory, most-recently-used first. */
  activeSessionIds: string[];
  /** Maximum concurrently loaded sessions before LRU eviction kicks in; zero means no cap. */
  maxLoadedSessions: number;
}

/** How hard a model is asked to think, for those that offer the choice. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How much room a session has to work in, for models that offer more than one size. */
export type ContextTier = 'default' | 'long_context';

/** One of the sizes a model can be run at, named by what it will actually take. */
export interface ModelContext {
  tier: ContextTier;
  /** Prompt tokens this tier allows, which is what distinguishes it from the other. */
  maxPromptTokens: number;
}

/**
 * What a million tokens costs, in credits.
 *
 * The runtime quotes a price per billing batch, which is not the same thing for every
 * model, so it is converted here rather than left for the UI to get wrong.
 */
export interface ModelPrices {
  input?: number;
  cachedInput?: number;
  output?: number;
}

/**
 * A model a session can be switched to.
 *
 * Trimmed from what the runtime reports, which carries pricing tables and vision limits
 * that no part of this app shows.
 */
export interface ModelChoice {
  id: string;
  name: string;
  /** The levels this model offers, empty when it does not take direction on thinking. */
  reasoningEfforts: ReasoningEffort[];
  /** The level it would pick for itself, when it says. */
  defaultReasoningEffort?: ReasoningEffort;
  /** The sizes it can run at. One means there is nothing to choose. */
  contexts: ModelContext[];
  prices?: ModelPrices;
  /** Offered but not usable: a policy has to be accepted before it will answer. */
  needsAgreement: boolean;
}

/** What a session runs on, as of the last thing its log has to say about it. */
export interface SessionModel {
  model: string;
  reasoningEffort?: string;
  contextTier?: string;
}

/**
 * Something sent along with a message.
 *
 * The runtime takes several shapes - directories, selections, raw blobs - and this is the
 * one a file picker produces. The others are different gestures and can be added when
 * something in the app makes them.
 */
export interface Attachment {
  type: 'file';
  path: string;
  displayName?: string;
}

export interface SendParams {
  sessionId: string;
  prompt: string;
  /** Files to send with it. Referenced by path: the runtime reads them, not this app. */
  attachments?: Attachment[];
  /**
   * `enqueue` queues behind an in-flight turn instead of starting a new one.
   *
   * Left unset the runtime decides, which is what a caller usually wants: it is the one
   * that knows whether a turn is running, and it cannot race itself.
   */
  mode?: 'enqueue' | 'immediate';
}

export interface SendResult {
  messageId: string;
  /**
   * The message went behind a turn already running rather than starting one.
   *
   * The caller cannot work this out for itself without repeating the runtime's own
   * bookkeeping, and it decides whether the message belongs in the transcript yet.
   */
  queued: boolean;
}

/** What the user chose for a pending permission request. */
export type PermissionChoice = 'approve-once' | 'approve-for-session' | 'reject';

export interface ResolvePermissionParams {
  sessionId: string;
  requestId: string;
  choice: PermissionChoice;
}

/**
 * A tool permission request awaiting a decision.
 * `request` is the SDK's PermissionRequest, a union discriminated by `kind`
 * (shell, write, read, mcp, custom-tool, url, ...).
 */
export interface PendingPermission {
  sessionId: string;
  requestId: string;
  request: Record<string, unknown>;
}

/** How the user answered a question from the agent. */
export type ElicitationAction = 'accept' | 'decline' | 'cancel';

/** A value a form field can hold, matching the SDK's ElicitationFieldValue. */
export type ElicitationFieldValue = string | number | boolean | string[];

/**
 * A question from the agent awaiting an answer, the equivalent of the CLI's ask_user.
 * `schema` is the SDK's ElicitationSchema: an object schema whose fields are single
 * select, multi select, boolean, free text or numeric.
 */
export interface PendingElicitation {
  sessionId: string;
  requestId: string;
  /**
   * The CLI has two ask_user variants and uses whichever the session was created with.
   * `input` is the legacy shape: a question with optional suggested choices, answered
   * with a single string. `form` is elicitation, carrying a JSON Schema of fields. Both
   * look the same to the user; the kind decides how the answer is sent back.
   */
  kind: 'input' | 'form';
  message: string;
  schema: Record<string, unknown> | null;
  /** Suggested answers, for the legacy variant. */
  choices: string[];
  /** `url` asks the user to visit a link rather than fill in a form. */
  mode: 'form' | 'url' | null;
  url: string | null;
}

export interface ResolveElicitationParams {
  requestId: string;
  action: ElicitationAction;
  content?: Record<string, ElicitationFieldValue>;
}

/** One of the fixed values a command's argument accepts, such as `on` or `off`. */
export interface CommandChoice {
  name: string;
  description: string;
}

/**
 * A slash command, as the runtime describes itself.
 *
 * Trimmed from the runtime's own metadata, which also carries whether a command may be the
 * target of a schedule and which source registered it - neither of which changes what this
 * app draws or how it dispatches.
 */
export interface SlashCommand {
  /** Without the leading slash, which is how it is invoked. */
  name: string;
  description: string;
  /** Other names for the same command, matched alongside the canonical one. */
  aliases: string[];
  /** What the argument is for, for commands that take one. */
  hint?: string;
  /** The command will not do anything useful without an argument. */
  required?: boolean;
  /** The values the argument accepts, when it is a choice rather than free text. */
  choices?: CommandChoice[];
  /** Whether it may run while a turn is in flight. */
  allowDuringTurn: boolean;
  experimental?: boolean;
}

/**
 * What invoking a command produced.
 *
 * Narrowed from the runtime's union, which has eight arms describing effects a terminal
 * client applies to itself. The three that carry something to show are kept as they are;
 * the rest collapse into `unsupported` so an unhandled one says so rather than looking
 * like a command that did nothing.
 */
export type CommandOutcome =
  /** Output to show. Already stripped of terminal escapes, which this app cannot draw. */
  | { kind: 'text'; text: string; markdown?: boolean }
  /** The command wants a prompt sent to the agent on the user's behalf. */
  | { kind: 'prompt'; prompt: string; notice?: string }
  /** It did its work itself; the message, when there is one, is the confirmation. */
  | { kind: 'done'; message?: string }
  /** An effect this app has no way to apply yet. `what` is the runtime's own name for it. */
  | { kind: 'unsupported'; what: string };

/**
 * A file a session changed, as its rewind snapshots record it.
 *
 * Only the agent's own work: the snapshots are written around the tool calls that changed
 * the file, so an edit someone made alongside in an editor never enters them. That is what
 * a git diff of the same directory cannot separate.
 */
export interface SessionChange {
  /** As the tool that changed it named it, which is how the store keys it. */
  path: string;
  status: 'created' | 'modified' | 'deleted';
  /** Across the whole session, not summed per turn - see the sidecar for why they differ. */
  linesAdded: number;
  linesRemoved: number;
  /** How many turns touched it. */
  turns: number;
  /** ISO-8601 timestamp of the last turn that did. */
  changedAt: string;
  /** Whether both ends survive on disk, so asking for the diff will produce one. */
  diffable: boolean;
}

/** The diff for one changed file, or why there is not one. */
export interface FileDiff {
  /** Unified diff from what the session found to what it left. */
  patch: string | null;
  /**
   * `pruned` - the CLI cleans up backing blobs, and around a quarter of them are gone.
   * `binary` - nothing a text diff would say anything useful about.
   * `untracked` - no snapshot mentions this path.
   */
  reason?: 'pruned' | 'binary' | 'untracked';
  /**
   * The file on disk is no longer what the session left.
   *
   * Someone has edited it since, so the diff describes the session's work rather than the
   * file's current state. Saying so is the alternative to quietly attributing their edit
   * to the agent.
   */
  stale: boolean;
}

/** Requests the frontend may issue. */
export interface SidecarRequests {
  'sessions.list': { params: void; result: ListSessionsResult };
  /** Sessions matching the start of an id, including the ones the list hides. */
  'sessions.find': { params: { prefix: string }; result: ListSessionsResult };
  'sessions.transcript': { params: GetTranscriptParams; result: GetTranscriptResult };
  'sessions.send': { params: SendParams; result: SendResult };
  'sessions.abort': { params: { sessionId: string }; result: void };
  'sessions.evict': { params: { sessionId: string }; result: void };
  'sessions.resolvePermission': { params: ResolvePermissionParams; result: void };
  'sessions.resolveElicitation': { params: ResolveElicitationParams; result: void };
  'sessions.create': { params: { workingDirectory?: string }; result: { sessionId: string } };
  /**
   * What a session changed, read from its rewind snapshots.
   *
   * Costs no Copilot process: the snapshots are files, so a session that has never been
   * opened in this app can still answer.
   */
  'sessions.changes': { params: { sessionId: string }; result: { changes: SessionChange[] } };
  /** The diff for one of those files. */
  'sessions.diff': { params: { sessionId: string; path: string }; result: FileDiff };
  'git.state': { params: { cwd: string }; result: { state: TreeState | null } };
  'models.list': { params: void; result: { models: ModelChoice[] } };
  /**
   * The slash commands there are.
   *
   * Takes a session because a loaded one knows about a few more than the runtime does in
   * general - the ones that only mean something inside a conversation, such as /compact -
   * but never resumes one to find out.
   */
  'commands.list': { params: { sessionId?: string }; result: { commands: SlashCommand[] } };
  /** Run a command in a session, resuming it if it is cold. */
  'commands.invoke': {
    params: { sessionId: string; name: string; input?: string };
    result: { outcome: CommandOutcome };
  };
  'sessions.model': { params: { sessionId: string }; result: { current: SessionModel | null } };
  'sessions.setModel': {
    params: { sessionId: string; model: string; reasoningEffort?: ReasoningEffort; contextTier?: ContextTier };
    result: void;
  };
  'runtime.status': { params: void; result: RuntimeStatus };
}

export type SidecarMethod = keyof SidecarRequests;

/** Notifications the sidecar pushes to the frontend. */
export interface SessionEventNotification {
  sessionId: string;
  event: TranscriptEvent;
}

export interface SessionLoadedNotification {
  sessionId: string;
  loaded: boolean;
}

/** Sent when a pending request is answered or abandoned, so the UI can clear it. */
export interface PermissionResolvedNotification {
  sessionId: string;
  requestId: string;
}

/** Sent when a question is answered or abandoned, so the UI can clear it. */
export interface ElicitationResolvedNotification {
  requestId: string;
}

/** Sent when the session list may have changed, so the sidebar can refetch. */
export const NOTIFY_SESSIONS_CHANGED = 'sessions.changed';

/** Method names used by sidecar-initiated notifications. */
export const NOTIFY_SESSION_EVENT = 'session.event';
export const NOTIFY_SESSION_LOADED = 'session.loaded';
export const NOTIFY_PERMISSION_REQUESTED = 'permission.requested';
export const NOTIFY_PERMISSION_RESOLVED = 'permission.resolved';
export const NOTIFY_ELICITATION_REQUESTED = 'elicitation.requested';
export const NOTIFY_ELICITATION_RESOLVED = 'elicitation.resolved';

export interface JsonRpcRequest<M extends SidecarMethod = SidecarMethod> {
  jsonrpc: '2.0';
  id: number;
  method: M;
  params?: SidecarRequests[M]['params'];
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Server-initiated notification, e.g. streamed assistant output. */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Which branch a working directory is on, and whether its tree is clean.
 *
 * The markers follow the convention a shell prompt uses, so anyone who reads one already
 * knows what they mean.
 */
export interface TreeState {
  /** The branch name, or the short commit when there is no branch to name. */
  branch: string;
  detached: boolean;
  /** Tracked files differ from the index. */
  modified: boolean;
  untracked: boolean;
  /** Something is staged for the next commit. */
  staged: boolean;
  /**
   * The `owner/repo` this checkout pushes to on GitHub, or null when it does not.
   *
   * Read from the remote rather than taken from the session store, which records a name
   * without saying where it came from. A directory can be a git repository, or a GitHub
   * one, or neither, and only the second has a page to link to.
   */
  remote: string | null;
}
