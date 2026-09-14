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

/**
 * The largest pasted file the composer will take.
 *
 * Pasted content has no path, so it crosses the pipe as base64 and is written out the far
 * side. Ten megabytes covers any screenshot with room to spare; past that the picker is
 * the right gesture, because it hands over a path and copies nothing.
 */
export const MAX_PASTE_BYTES = 10 * 1024 * 1024;

/** A pasted file on its way to disk, since only a path can be attached to a message. */
export interface StashParams {
  sessionId: string;
  /** What the clipboard called it. Screenshots all arrive as `image.png`. */
  name: string;
  /** The bytes, base64. */
  data: string;
}

/**
 * The largest image the app will preview.
 *
 * A preview crosses the pipe as base64, so the cost is the file's size again by a third,
 * paid to show a thumbnail. Four megabytes covers a screenshot or a photograph; a scan or
 * a layered export is past the point where a hover is the right way to look at it.
 */
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

/**
 * Extensions the app will preview, and what to call them in a data URL.
 *
 * A list rather than a lookup by content, because the point is to refuse anything unfamiliar:
 * an attachment is whatever the reader picked, and the webview should only be handed types
 * it can decode without running anything. SVG is left out for that reason - it is a document,
 * not a bitmap.
 */
export const PREVIEWABLE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

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
  /**
   * When this lapses on its own, so the prompt can say how long is left (#70).
   *
   * A blocked agent is the one wait that ends badly if nobody notices it: the request is
   * answered as "user not available" after five minutes and the turn carries on without
   * whatever was being asked for.
   */
  expiresAt: string;
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
  /** When this lapses on its own, as a permission does. Giving up counts as declining. */
  expiresAt: string;
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
  /** The values the argument accepts, when it is a choice rather than free text. */
  choices?: CommandChoice[];
  /** Whether it may run while a turn is in flight. */
  allowDuringTurn: boolean;
  experimental?: boolean;
}

/**
 * A custom agent the runtime found.
 *
 * Narrowed from the runtime's `AgentInfo`, which also carries the agent's entire prompt, its
 * tool list and its MCP servers. A list of agents to choose between needs none of those, and
 * a prompt is not small, so they are dropped here rather than carried across the wire to be
 * ignored at the other end.
 */
export interface AgentSummary {
  /** Stable id, with any plugin namespace normalised into it. */
  id: string;
  /** The name `select` is given, which is not always the name shown. */
  name: string;
  displayName: string;
  description: string;
  /** Where it was found: the reader's own directory, a project, or a named plugin. */
  source: string;
  /** The file it was read from, for agents that came from one. */
  path?: string;
  /** The model it pins itself to, for the agents that name one. */
  model?: string;
  /** Whether the reader may choose it, as against it only being spawned by other agents. */
  userInvocable: boolean;
}

/**
 * The custom agent a session is on.
 *
 * Two fields rather than an `AgentSummary` because this can be answered from the session's
 * own log, and the log records only what was chosen - the name and how to show it. Anything
 * more would mean matching it back to a discovered agent, which is the caller's to do if it
 * wants it, and would fail for an agent whose file has since been deleted.
 */
export interface SessionAgent {
  name: string;
  displayName: string;
}

/**
 * An instructions file the runtime would load, and what is in it.
 *
 * The content is carried rather than fetched on demand because the whole point of showing
 * this is answering why an agent behaved as it did, and a list of paths does not answer it.
 * These are documents someone wrote by hand, so they are kilobytes, not megabytes.
 */
export interface InstructionSource {
  id: string;
  /** How the runtime describes it, e.g. "Home copilot-instructions.md". */
  label: string;
  sourcePath: string;
  content: string;
  /** Which kind of file it is: home, repo, model, vscode, nested-agents, child-instructions. */
  type: string;
  /** Which scope it lives in: user, repository, working-directory, plugin. */
  location: string;
}

/** An installed plugin, as the runtime records it. */
export interface PluginSummary {
  name: string;
  marketplace: string;
  /** Absent for a plugin whose manifest does not give one. */
  version?: string;
  enabled: boolean;
}

/** An extension the runtime found in the reader's Copilot home. */
export interface ExtensionSummary {
  id: string;
  name: string;
  path: string;
  /** Where it came from: the reader's own directory, or a plugin. */
  source: string;
  enabled: boolean;
  /** The plugin that contributes it, for the ones that come from one. */
  plugin?: string;
}

/**
 * A skill the runtime would offer, and whether this session is using it.
 *
 * `enabled` is the runtime's global answer; `disabled` is this app's per-session one, kept
 * here rather than asked of the session because a session-scoped disable does not survive
 * a resume (measured), and this app disconnects idle sessions on purpose.
 */
export interface SkillSummary {
  name: string;
  /** What typing it as a slash command looks like, without the leading `/`. */
  commandName?: string;
  description: string;
  /** Where it was found: project, personal-copilot, personal-agents, plugin, builtin, custom. */
  source: string;
  /** Whether it can be typed as a slash command, as against only the agent reaching for it. */
  userInvocable: boolean;
  /** Whether the runtime has it on at all, which a per-session choice cannot override. */
  enabled: boolean;
  /** The SKILL.md it was read from, for the skills that have one. */
  path?: string;
}

/**
 * What a session in a given directory would load, short of loading it.
 *
 * Answered from the sessionless server surface, so opening this costs no session. The
 * working directory is the only thing that changes the answer, which is why it is the only
 * input: instructions and extensions are discovered per project, plugins are global.
 */
export interface SessionEnvironment {
  instructions: InstructionSource[];
  plugins: PluginSummary[];
  extensions: ExtensionSummary[];
  skills: SkillSummary[];
  /**
   * Whether extensions are loaded at all, and whether the agent may manage them.
   * Worth showing, because an empty list means something different under `disabled`.
   */
  extensionMode: string;
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
 * What a reader's own shell command produced.
 *
 * The output is here as well as in the event log because the runtime emits the command as
 * a tool call: the transcript will show it in its own time, and this is the answer to the
 * request that started it.
 */
export interface ShellResult {
  success: boolean;
  /** Already stripped of terminal escapes, which this app cannot draw. */
  output: string;
  exitCode?: number;
  error?: string;
}

/**
 * Something waiting behind the turn a session is running.
 *
 * The runtime's own queue, not a copy kept here, so it also carries what this app did not
 * put there: commands queued during a turn, model changes, and messages sent from a
 * terminal attached to the same session.
 */
export interface QueuedItem {
  /** Stable and opaque. What the runtime wants back to remove, edit or move the entry. */
  id: string;
  kind: 'message' | 'command' | 'other';
  text: string;
  /** Present for messages only, and the same id the `user.message` event carries. */
  messageId?: string;
}

/**
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
   * Why there is no patch, in terms the reader can go and check for themselves.
   *
   * The store is not self-contained: a version is kept as a blob only when it is not what
   * the file already holds, so the two ends of a change are often read back off disk. Both
   * ways of losing that are worth telling apart, because only one of them is recoverable.
   *
   * `gone` - the file is not there any more, and no copy of it was kept.
   * `replaced` - the file is still there but is no longer that version, and no copy was kept.
   * `binary` - nothing a text diff would say anything useful about.
   * `too-large` - comparing two versions this size would stall every session in the app.
   * `untracked` - no snapshot mentions this path.
   */
  reason?: 'gone' | 'replaced' | 'binary' | 'too-large' | 'untracked';
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
  /** Which of the given sessions still exist on disk, so what the app remembers can be pruned. */
  'sessions.exist': { params: { sessionIds: string[] }; result: { sessionIds: string[] } };
  'sessions.transcript': { params: GetTranscriptParams; result: GetTranscriptResult };
  'sessions.send': { params: SendParams; result: SendResult };
  'sessions.abort': { params: { sessionId: string }; result: void };
  /**
   * Run a shell command the reader typed, in the session's own shell.
   *
   * `requestId` is the caller's to choose and is the handle `sessions.cancelShell` needs.
   */
  'sessions.shell': { params: { sessionId: string; requestId: string; command: string }; result: ShellResult };
  'sessions.cancelShell': { params: { sessionId: string; requestId: string }; result: void };
  'sessions.evict': { params: { sessionId: string }; result: void };
  'sessions.resolvePermission': { params: ResolvePermissionParams; result: void };
  'sessions.resolveElicitation': { params: ResolveElicitationParams; result: void };
  'sessions.create': { params: { workingDirectory?: string }; result: { sessionId: string } };
  /**
   * What a session changed, read from its rewind snapshots.
   *
   * Costs no Copilot process: the snapshots are files, so a session that has never been
   * opened in this app can still answer.
   *
   * `since` narrows it to the turns after a moment, for "what has happened since I last
   * looked at this". It is a snapshot timestamp rather than a wall clock reading, so it
   * does not depend on the two sides agreeing about the time.
   */
  'sessions.changes': { params: { sessionId: string; since?: string }; result: { changes: SessionChange[] } };
  /** The diff for one of those files, over the same span the list was built with. */
  'sessions.diff': { params: { sessionId: string; path: string; since?: string }; result: FileDiff };
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
  /** Queue a command behind the running turn. False when the session does not queue locally. */
  'commands.enqueue': {
    params: { sessionId: string; command: string; displayText?: string };
    result: { queued: boolean };
  };
  /**
   * The custom agents there are.
   *
   * Asked of the server rather than of a session, which is the point: the session surface has
   * its own `agent.list`, and using it would mean resuming a session to find out what agents
   * exist. Browsing should never cost what running costs.
   *
   * `cwd` is passed on as a project path, because a session in a repository can see agents
   * that repository carries as well as the reader's own.
   *
   * Built-in agents are not among these. Only a loaded session can list those, and a cold
   * list that quietly left some out would be worse than one that never offered them.
   */
  'agents.list': { params: { cwd?: string }; result: { agents: AgentSummary[] } };
  /** The agent a session is on, or null for the default. Read from its log, so it costs no process. */
  'agents.current': { params: { sessionId: string }; result: { agent: SessionAgent | null } };
  /** Choose an agent for a session's next turns, resuming it if it is cold. */
  'agents.select': { params: { sessionId: string; name: string }; result: void };
  /** Return a session to the default agent, resuming it if it is cold. */
  'agents.deselect': { params: { sessionId: string }; result: void };
  /**
   * What a session in this directory would load: its instructions, plugins, extensions and skills.
   *
   * Asked of the server for the same reason `agents.list` is. Every part of this is
   * discoverable without a session, so answering it never resumes one, and the panel works
   * on a session the app has never opened.
   */
  'environment.describe': { params: { cwd?: string }; result: SessionEnvironment };
  /**
   * The skills a session has switched off, and the means to switch one.
   *
   * Both cost no process. The set belongs to the app rather than to the runtime, whose own
   * per-session disable is forgotten on the next resume; this one is re-applied on every
   * resume, so it holds for a session that is evicted and started again.
   */
  'skills.disabled': { params: { sessionId: string }; result: { disabled: string[] } };
  /** Switch one skill on or off for one session. Tells a loaded session; leaves a cold one cold. */
  'skills.set': {
    params: { sessionId: string; name: string; enabled: boolean };
    result: { disabled: string[] };
  };
  /** The runtime's own queue. Empty for a session that is not loaded, which is not resumed to ask. */
  'sessions.queue': { params: { sessionId: string }; result: { items: QueuedItem[] } };
  'sessions.model': { params: { sessionId: string }; result: { current: SessionModel | null } };
  'sessions.setModel': {
    params: { sessionId: string; model: string; reasoningEffort?: ReasoningEffort; contextTier?: ContextTier };
    result: void;
  };
  'runtime.status': { params: void; result: RuntimeStatus };
  /** Writes a pasted file beside the session's record, since a message can only carry a path. */
  'attachments.stash': { params: StashParams; result: { path: string } };
  /**
   * An image as a data URL, for showing a file the webview cannot load itself.
   *
   * Null covers every reason there is nothing to show - gone, unreadable, too large, or not
   * an image at all - because the caller does the same thing in all four cases.
   */
  'attachments.preview': { params: { path: string }; result: { dataUrl: string | null } };
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

/**
 * Sent when a turn recorded what it changed, so an open list of changes can catch up.
 *
 * Only when something was actually written. Re-reading a session's changes costs reading
 * every file it touched at both ends, so a turn that changed nothing must not pay for it.
 */
export interface SessionChangesNotification {
  sessionId: string;
}

/** Method names used by sidecar-initiated notifications. */
export const NOTIFY_SESSION_EVENT = 'session.event';
export const NOTIFY_SESSION_LOADED = 'session.loaded';
export const NOTIFY_SESSION_CHANGES = 'session.changes';
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

/**
 * One handler per method, taking and returning what the table above says.
 *
 * The sidecar used to answer requests from a switch that cast `params` by hand in every
 * branch, which restated all of these shapes a second time and let the two drift without a
 * word from the compiler. Written this way, a method with no handler, a handler reading a
 * parameter that is not sent, and a handler answering with the wrong shape are all build
 * errors, and both sides of the boundary are checked against the same declaration.
 */
export type SidecarHandlers = {
  [M in SidecarMethod]: (
    params: SidecarRequests[M]['params'],
  ) => SidecarRequests[M]['result'] | Promise<SidecarRequests[M]['result']>;
};

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
