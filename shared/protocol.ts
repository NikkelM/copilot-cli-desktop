/**
 * Wire protocol shared between the Tauri shell, the React frontend and the Node sidecar.
 * Kept dependency-free so both tsconfigs can include it directly.
 */

/** A session as shown in the sidebar. Sourced from session-store.db - never requires a running CLI process. */
/**
 * A session that said what was searched for, and where it said it.
 *
 * One per session rather than one per hit: the sidebar lists sessions, so the best-ranked
 * excerpt is the one worth showing and the rest would only push other sessions off the end.
 */
export interface SessionMatch {
  sessionId: string;
  /**
   * The words around the match, with the matched words wrapped in STX and ETX.
   *
   * Control characters rather than markup, because the excerpt is drawn as text and anything
   * a reader could have typed - `<b>`, `**`, `[` - would be indistinguishable from a match
   * that happened to contain it.
   */
  excerpt: string;
  /**
   * Where the match came from, as the index's own composite handle.
   *
   * `<sessionId>:turn:269` or `<sessionId>:ckpt:0:checkpoint_history`. Passed back rather
   * than picked apart here, because what it takes to reach each kind differs and the sidecar
   * is where that is known.
   */
  source: string;
}

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
  /** Whether a live runtime session is currently held in memory. */
  loaded: boolean;
}

/**
 * A session waiting in the recycle bin.
 *
 * Remembered beside the directory that was moved rather than inside it, so a restored
 * session is put back exactly as it was and the bin can be listed without asking the CLI
 * about sessions it no longer has.
 */
export interface BinnedSession {
  sessionId: string;
  /** What the sidebar called it when it was deleted. */
  title: string | null;
  /** ISO-8601. What the retention is counted from. */
  binnedAt: string;
  /** ISO-8601, when it was last used, or null if that was never known. */
  updatedAt: string | null;
  /** Bytes on disk, so the bin can say what emptying it is worth. */
  bytes: number;
}

/** How long a deleted session is kept when nobody has said otherwise. */
export const DEFAULT_BIN_RETENTION_DAYS = 7;

/**
 * What one session is costing on disk.
 *
 * Read from the directories rather than from the session store, since disk is what is being
 * asked about: a session the store has forgotten still has its bytes, and those are exactly
 * the ones nothing else in the app would ever mention.
 */
export interface SessionDisk {
  sessionId: string;
  /** What the sidebar calls it, or nothing for a directory the session store has no row for. */
  title: string | null;
  /** ISO-8601, when it was last used, or null where the store cannot say. */
  updatedAt: string | null;
  bytes: number;
  /** Whether the session store still knows about it, and so whether the sidebar shows it. */
  listed: boolean;
}

/** How long a question to the reader waits when nobody has said otherwise. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

/** The kinds of CLI setting this app draws a control for. The schema has others it cannot. */
export type CliSettingKind = 'boolean' | 'enum' | 'number' | 'string';

/**
 * One of the Copilot CLI's own settings, as the CLI describes it.
 *
 * Read from the runtime the reader actually has rather than written down here, so a setting
 * the CLI adds appears without this app being rebuilt (#202).
 */
export interface CliSetting {
  /** Dotted, as the CLI's file holds it: `autoUpdate`, `sandbox.enabled`. */
  path: string;
  kind: CliSettingKind;
  /** The CLI's own words, which are written for a reader rather than for a schema. */
  description: string;
  /** What an enum may be. Absent for every other kind. */
  options?: string[];
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
  /**
   * Which subagent produced it, absent for the root agent and for session-level events.
   *
   * Always at the top level rather than inside `data`, confirmed across every log on this
   * machine. Its form has changed with the CLI: older sessions set it to the id of the
   * `task` tool call that spawned the agent, newer ones to a uuid of the agent's own. One
   * log carries both, so nothing may assume either - `subagent.started` names the tool call
   * in its payload, and that is the way back to the row that delegated the work.
   */
  agentId?: string;
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
  /**
   * Whether the CLI could open this session again, which it can only do from a log that
   * still begins where one must.
   *
   * Reported rather than left to be discovered on the first message, because a session whose
   * history is gone looks exactly like a new one: it draws an empty transcript and invites a
   * prompt that cannot be answered.
   *
   * Only the opening page says: it is read from the front of the log, and the pages after it
   * are reached by going backwards from the end.
   */
  reopenable?: boolean;
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
 * How a session is working, mirroring the SDK's own union.
 *
 * `interactive` is the ordinary back-and-forth and is what a session runs in unless told
 * otherwise. `plan` has the agent write a plan and stop for approval before acting on it.
 * `autopilot` has it work towards a goal without stopping to check in.
 */
export type SessionMode = 'interactive' | 'plan' | 'autopilot';

/**
 * How full a loaded session's context window is.
 *
 * Only ever known for a session the runtime already holds. The figures are not written to
 * the event log - `session.usage_info` is emitted live and never persisted - so a session
 * nobody has opened cannot be asked how much room it has left, and asking must not be what
 * loads it.
 */
export interface SessionContextUsage {
  /** System prompt, conversation and tool definitions together: the numerator of `##k/###k`. */
  totalTokens: number;
  /** Most the model will take, and so the denominator. */
  promptTokenLimit: number;
  /** Where background compaction starts, which is the number worth warning before. */
  compactionThreshold: number;
  /** The `/context` buckets, for saying what the room went on rather than only how much. */
  categories: {
    systemPrompt: number;
    customInstructions: number;
    systemTools: number;
    mcpTools: number;
    messages: number;
    freeSpace: number;
  };
  /** How many times this session's history has already been compacted away. */
  compactions: number;
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
   * A directory that could be allowed outright, or absent when there is nothing to offer.
   *
   * Set only when the request names a path the session is not already allowed to work in,
   * which is the case that asks twice: tool permission and path verification are separate
   * gates, and a path outside the allow-list trips both with byte-identical requests (#210).
   *
   * Worked out here rather than in the window, so the question of what is already allowed
   * is asked of the runtime once per request rather than guessed at from a path.
   */
  offerFolder?: string;
  /**
   * When this lapses on its own, so the prompt can say how long is left (#70).
   *
   * A blocked agent is the one wait that ends badly if nobody notices it: the request is
   * answered as "user not available" once the wait runs out and the turn carries on
   * without whatever was being asked for.
   *
   * Null when the reader has asked for no wait at all, since there is then nothing to
   * count down to and the question stands until it is answered (#201).
   */
  expiresAt: string | null;
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
  expiresAt: string | null;
}

export interface ResolveElicitationParams {
  requestId: string;
  action: ElicitationAction;
  content?: Record<string, ElicitationFieldValue>;
}

/** What the reader chose to do once the agent's plan was accepted. */
export type PlanAction = 'exit_only' | 'interactive' | 'autopilot' | 'autopilot_fleet';

/**
 * A plan the agent wants approval to act on, the checkpoint plan mode exists for.
 *
 * Unlike a permission or a question this is not a yes/no: approving it also decides how
 * the work proceeds, which is what `actions` offers. Nothing is shown for an unapproved
 * plan on a cold session because the request is ephemeral and never reaches the log.
 */
export interface PendingPlanApproval {
  sessionId: string;
  requestId: string;
  /** One-line summary of what the agent intends to do. */
  summary: string;
  /** The plan itself, as markdown. */
  planContent: string;
  /**
   * The ways forward the agent is willing to offer, which is not always all four: it
   * decides whether to put the fleet option up at all. Shown as sent rather than from a
   * fixed list, so an option the agent withheld is never offered.
   */
  actions: PlanAction[];
  /** The agent's own suggestion, which the UI labels and puts first. */
  recommendedAction: PlanAction;
  /** When this lapses on its own. Giving up leaves the plan unapproved. */
  expiresAt: string | null;
}

export interface ResolvePlanParams {
  requestId: string;
  approved: boolean;
  /** Only meaningful on approval; how the agent should carry on. */
  selectedAction?: PlanAction;
  /** Why the plan was turned down, which is how a reader redirects one. */
  feedback?: string;
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
  /** Whether the runtime refuses an empty argument. */
  required?: boolean;
  /** How the runtime says clients should complete the argument. */
  completion?: 'directory';
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
  /** The MCP servers a session here would be offered, and whether each is switched on. */
  mcpServers: McpServerSummary[];
  /** The custom agents a session here could be run as. */
  agents: AgentSummary[];
  /** The hooks that would fire for a session here. */
  hooks: HookSummary[];
  /** The language servers a session here would be offered. */
  lsps: LspSummary[];
  /**
   * Skills that were found but could not be read, as the runtime described them.
   *
   * Worth reporting rather than dropping: a malformed SKILL.md simply goes missing from the
   * list otherwise, which reads as never having been installed.
   */
  skillErrors: string[];
  /** The same for hooks, which fail the same silent way and for the same reasons. */
  hookErrors: string[];
  /**
   * Whether extensions are loaded at all, and whether the agent may manage them.
   * Worth showing, because an empty list means something different under `disabled`.
   */
  extensionMode: string;
}

/**
 * A hook that would fire for a session in this directory.
 *
 * Hooks carry no name and no description - the runtime identifies one by a hash. What there
 * is to show is when it fires, where it came from, and the file it was written in, which is
 * also the only place it can be changed (#165).
 */
export interface HookSummary {
  /** The runtime's own id, which is a hash rather than anything to read. */
  id: string;
  /** When it fires: `preToolUse`, `agentStop`, and the rest. */
  event: string;
  /** Where it came from: the reader's own settings, the repository, a plugin, or policy. */
  origin: string;
  /** The file it was written in. Absent for a hook the runtime did not attribute. */
  source?: string;
  /** Whether it will actually fire. A disabled hook stays configured. */
  enabled: boolean;
}

/**
 * An MCP server a session in this directory would be offered.
 *
 * Discovered rather than read from a session, so this costs no Copilot process and answers
 * for a directory no session has ever run in. What it cannot say is whether the server
 * actually connected: that is a fact about a running session, and only one that is loaded
 * can be asked (#24).
 */
export interface McpServerSummary {
  /** The key it is configured under, which is also how it is enabled or disabled. */
  name: string;
  /** How it is reached - `http`, `stdio`, and so on. Absent when the runtime did not say. */
  type?: string;
  /** Where it came from: the reader's own config, the workspace, a plugin, or built in. */
  source: string;
  /** Named when a plugin provided it, since that is where it would have to be changed. */
  sourcePlugin?: string;
  /** Whether new sessions will start it. A disabled server stays configured. */
  enabled: boolean;
  /** What an HTTP server is reached at. */
  url?: string;
  /** What a stdio server runs, and with what. */
  command?: string;
  args?: string[];
  /**
   * Whether this app can change it.
   *
   * True for a server in the reader's own config file, which is the one the config RPC
   * writes. A plugin's server is real, runs, and can be switched off - but editing it here
   * would write a copy into the reader's file rather than change the plugin's, so it is
   * offered as something to read instead (#24).
   */
  editable: boolean;
}

/**
 * What an MCP server is actually doing in one session.
 *
 * The configured view says what a directory would be offered; this says what happened when
 * it was tried - connected, failed, waiting to be signed in to. Only a loaded session can
 * answer, because only a loaded session has tried (#24).
 */
export interface McpServerState {
  name: string;
  /** `connected`, `failed`, `needs-auth`, `pending`, `disabled`, `stopped`. */
  status: string;
  /** Why it failed, where the runtime said. */
  error?: string;
}

/**
 * A language server a session in this directory would be offered.
 *
 * Read from the config files rather than from a session, like the MCP servers beside them.
 * The SDK's only LSP method is `lsp.initialize`, which loads a configuration rather than
 * reporting one - but the configuration is `~/.copilot/lsp.json` and `.github/lsp.json`,
 * which this app can read for itself (#165).
 */
export interface LspSummary {
  /** The key it is configured under. */
  name: string;
  /** What runs it, or nothing where the config gives only a script. */
  command?: string;
  /** The file extensions it is asked to handle, which is what it is for. */
  extensions: string[];
  /** Where it was configured: the reader's own file, or this project's. */
  source: string;
  /** Whether it will actually start. A disabled server stays configured. */
  enabled: boolean;
}

/**
 * How to reach an MCP server, as the reader would write it.
 *
 * The two shapes the runtime accepts, narrowed to what somebody actually types: everything
 * else in its config is a filter, a timeout or a telemetry policy, and inventing controls
 * for those here would be guessing at what they are for.
 */
export type McpServerConfig =
  | { transport: 'http'; url: string }
  | { transport: 'stdio'; command: string; args?: string[] };

/**
 * What invoking a command produced.
 *
 * Narrowed from the runtime's union, which has eight arms describing effects a terminal
 * client applies to itself. The three that carry something to show are kept as they are;
 * the rest collapse into `unsupported` so an unhandled one says so rather than looking
 * like a command that did nothing.
 */
export type CommandOutcome = (
  /** Output to show. Already stripped of terminal escapes, which this app cannot draw. */
  | { kind: 'text'; text: string; markdown?: boolean }
  /** The command wants a prompt sent to the agent on the user's behalf. */
  | { kind: 'prompt'; prompt: string; notice?: string }
  /** It did its work itself; the message, when there is one, is the confirmation. */
  | { kind: 'done'; message?: string; mode?: SessionMode }
  /** An effect this app has no way to apply yet. `what` is the runtime's own name for it. */
  | { kind: 'unsupported'; what: string }
) & {
  /**
   * The command changed settings, so anything holding a copy of them is now wrong.
   *
   * Carried on every kind because the runtime attaches it to every kind: a command can
   * report text, send a prompt or simply finish, and still have changed something on its
   * way past. Nothing here says which setting - only that a re-read is owed (#168).
   */
  settingsChanged?: boolean;
};

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

/**
 * A turn a session can be put back to, as the runtime lists them.
 *
 * The counts cover this turn and every later one, since that is what going back to it
 * would discard - not what the turn alone did.
 */
export interface RewindPoint {
  /** The user message that begins what would be discarded, which is what rewind is keyed by. */
  eventId: string;
  /**
   * The opening line of what was asked, so a turn can be recognised without counting back
   * through the log.
   *
   * A label rather than the prompt. The menu draws one line of it, and a prompt can carry a
   * pasted document, so sending the whole of every one would ship a session's worth of text
   * to write a list of rows.
   */
  message: string;
  at: string;
  /** Whether the files can be put back as well as the conversation. */
  canRestoreFiles: boolean;
  /** Unique files this turn and every later one changed. */
  fileCount: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Why a session cannot be rewound.
 *
 * `busy` is the one worth retrying: the session still holds work that could change files
 * or history, so the same request answers differently once it settles.
 */
export type RewindUnavailable = 'untracked' | 'busy' | 'remote';

/** What a rewind would put back, asked before anything is done. */
export interface RewindPreview {
  available: boolean;
  reason?: RewindUnavailable;
  files: { path: string; status: 'created' | 'modified' | 'deleted'; linesAdded: number; linesRemoved: number }[];
}

/**
 * How a rewind went.
 *
 * Not collapsed to a boolean, because the failures differ in what they left on disk: files
 * put back with the conversation intact is a different thing to tell somebody than nothing
 * having happened at all.
 */
export interface RewindResult {
  outcome:
    | 'success'
    | 'busy'
    | 'untracked'
    | 'remote'
    /** Restoring failed and what it had done was undone. The session is as it was. */
    | 'rolled-back'
    /** Restoring failed and undoing that did not fully succeed. The files need looking at. */
    | 'rollback-incomplete'
    /** The files may have been put back, but the conversation was not. */
    | 'truncation-failed'
    /** Done, but something the runtime keeps alongside it was not tidied up. */
    | 'partly-tidied';
  /** Absolute paths put back, empty unless the files were in scope and it got that far. */
  restoredFiles: string[];
  /** Captured files deliberately left alone, with why. */
  skippedFiles: { path: string; reason: string }[];
  error?: string;
}

/**
 * One page of the local knowledge base, as the browser's tree lists it.
 *
 * The path is relative to the wiki root and always uses forward slashes, so it reads the
 * same on either side of the wire and can be compared against the links inside a page.
 */
export interface WikiPage {
  path: string;
  /** From the page's frontmatter, falling back to its filename. */
  title: string;
  summary?: string;
  category?: string;
  /** ISO date the page last recorded, which is its own claim rather than the file's mtime. */
  updated?: string;
  tags?: string[];
}

/**
 * One page's contents: the file, as it is.
 *
 * Not split here. The app splits it anyway so it can preview a page being edited without a
 * round trip, and sending the parts as well would put the same file on the wire three times
 * with two copies never read.
 */
export interface WikiPageContent {
  path: string;
  source: string;
}

/**
 * One page answering a search, with enough to decide whether to open it.
 *
 * The score is the one `Search-Wiki.ps1` produces, so the ranking a reader already knows
 * from the terminal is the ranking they get here.
 */
export interface WikiSearchResult {
  path: string;
  title: string;
  score: number;
  /**
   * Where it matched, strongest first.
   *
   * Worth showing only when the match is not visible in the excerpt - a page found by its
   * keywords with nothing in its prose would otherwise be a title and no reason.
   */
  matchedIn: string[];
  summary?: string;
  /** The prose around the first match, for a reader deciding whether to open the page. */
  excerpt?: string;
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

/**
 * The event types the transcript can draw a row for.
 *
 * `toEntries` decides what the reader sees, and its own comment is the rule: anything it
 * has no case for is invisible. Roughly half of a page was being read, serialised, carried
 * across two process boundaries and handed to React so that it could be ignored - 49% of
 * the bytes and 59% of the events, measured over the newest page of 25 real sessions.
 *
 * The worst of it is `system.message`, which carries the whole system prompt: up to 305 KB
 * in a single page, 61% of that page on its own.
 *
 * So the transcript read sends only these. Nothing the reader would have seen is affected,
 * because an event outside this list drew nothing in the first place: the page still spans
 * the same events, it just stops carrying the ones that were only ever going to be dropped
 * at the other end.
 *
 * This is not a general filter on the log. The model, agent and mode of a cold session are
 * read from events that are deliberately absent from here, so only the transcript read
 * applies it.
 *
 * Kept in step with `toEntries` by a test rather than by intention: the two are a switch
 * statement in the frontend and a list in a shared module, with nothing but that test
 * linking them. A case added there without a name added here would silently stop arriving.
 */
export const TRANSCRIPT_EVENT_TYPES: readonly string[] = [
  'user.message',
  'assistant.message',
  'assistant.reasoning',
  'assistant.reasoning_delta',
  'assistant.message_delta',
  'tool.execution_start',
  'tool.user_requested',
  'tool.execution_partial_result',
  'tool.execution_complete',
  'session.error',
  'skill.invoked',
  'command.output',
  'command.failed',
  'abort',
  'session.idle',
  'session.shutdown',
  // What a delegated task did, which is drawn on the row that delegated it rather than as
  // rows of its own. The work itself is the subagent's and is nested inside that row.
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
];

const SHOWN = new Set(TRANSCRIPT_EVENT_TYPES);

/**
 * Whether the parent transcript would draw anything for this event.
 *
 * `agentId` marks a subagent's own work, which the root agent's events never carry. It is
 * kept rather than dropped: the transcript nests it inside the row that delegated it, which
 * is what lets a delegating turn be watched as it happens rather than reported once it is
 * over (#11).
 *
 * That is a decision about what a transcript is, not about what a page costs. A subagent is
 * 4% to 73% of a delegating session's drawable events, so it remains the largest thing in a
 * page and the first candidate for anything that needs one smaller.
 */
export function showsInTranscript(type: string): boolean {
  return SHOWN.has(type);
}

/**
 * What a session has spent.
 *
 * Two sources, and which one answered decides how much is here. A loaded session is asked
 * directly and can account for tokens, requests and the code it changed. A cold one is read
 * from the last usage checkpoint in its log, which carries the two running totals and
 * nothing else - and is exact: the figures a resumed session reports for them are the same
 * ones, rebuilt from that checkpoint.
 *
 * No session is ever resumed to answer this. Browsing what a session cost must not cost a
 * process, which is the rule the rest of this app is built on.
 */
export interface SessionUsage {
  /** Premium requests spent. Fractional, since a model's multiplier is applied to each. */
  premiumRequests: number;
  /** AI units, from the nano units the runtime counts in. */
  aiu: number;
  /** Whether a loaded session answered, and so whether the rest of this is present. */
  loaded: boolean;
  tokens?: SessionUsageTokens;
  /** API calls made, counted across models. Absent unless a loaded session said. */
  requests?: number;
  /** Time spent waiting on the model, in milliseconds. */
  apiDurationMs?: number;
  /** When the session began, as the runtime recorded it. */
  startedAt?: string;
  codeChanges?: { linesAdded: number; linesRemoved: number; filesModified: number };
  /** What each model was used for, largest cost first. */
  models?: SessionUsageModel[];
}

export interface SessionUsageTokens {
  input: number;
  output: number;
  /** Tokens read back from the prompt cache, which are charged differently from fresh ones. */
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface SessionUsageModel {
  model: string;
  requests: number;
  /** Premium requests attributed to this model. */
  cost: number;
}

/** Requests the frontend may issue. */
export interface SidecarRequests {
  'sessions.list': { params: void; result: ListSessionsResult };
  /** Sessions matching the start of an id, including the ones the list hides. */
  'sessions.find': { params: { prefix: string }; result: ListSessionsResult };
  /** Which of the given sessions still exist on disk, so what the app remembers can be pruned. */
  'sessions.exist': { params: { sessionIds: string[] }; result: { sessionIds: string[] } };
  'sessions.transcript': { params: GetTranscriptParams; result: GetTranscriptResult };
  /**
   * One subagent's own transcript, read from the session's log rather than held (#178).
   *
   * Separate from `sessions.transcript` because it answers a different question: not what
   * this conversation says, but what one agent it delegated to did. The events are the same
   * shape, so the same renderer draws them.
   */
  'sessions.agentTranscript': { params: { sessionId: string; agentId: string }; result: { events: TranscriptEvent[] } };
  'sessions.send': { params: SendParams; result: SendResult };
  'sessions.abort': { params: { sessionId: string }; result: void };
  /**
   * Run a shell command the reader typed, in the session's own shell.
   *
   * `requestId` is the caller's to choose and is the handle `sessions.cancelShell` needs.
   */
  'sessions.shell': { params: { sessionId: string; requestId: string; command: string }; result: ShellResult };
  'sessions.cancelShell': { params: { sessionId: string; requestId: string }; result: void };
  /**
   * Bring a session into memory before anything is asked of it.
   *
   * The opposite of `sessions.evict`. Nothing is resumed until it is needed, which is what
   * makes a long list free - but it means the first message waits on a resume, and somebody
   * who knows they are about to use a session can pay that while they are still reading.
   */
  /**
   * Give a session a name of somebody's choosing.
   *
   * Costs no session: the name lives in a file beside the transcript rather than in the
   * runtime, so a session nobody has opened can still be renamed.
   */
  'sessions.rename': { params: { sessionId: string; name: string }; result: void };
  /**
   * Change the two rules that decide what stays in memory.
   *
   * Applied to what is already running: lowering the cap releases sessions over it now, and
   * shortening the idle timeout restarts the countdowns rather than letting them finish to
   * the old length. A session in the middle of a turn is never released, whatever the cap
   * says (#100).
   *
   * `maxLoadedSessions` of zero is no cap, which is the default: how many sessions are worth
   * keeping is the reader's judgement. `idleTimeoutMs` of zero disables the timer.
   *
   * `binRetentionDays` rides along because it is the same kind of thing - a rule the app
   * keeps and the runtime enforces - and because saying it is also when the bin is swept:
   * the app says it as it starts and whenever it changes, which is exactly when what is
   * past its retention can have moved. Zero deletes immediately and keeps no bin.
   */
  'runtime.limits': {
    params: {
      maxLoadedSessions: number;
      idleTimeoutMs: number;
      binRetentionDays?: number;
      permissionTimeoutMs?: number;
      /**
       * Whether a session this app opens runs tools without asking.
       *
       * Carried here rather than only at creation because the permission mode does not
       * survive a session being released: a session resumed later starts asking again, so
       * it has to be set every time one is opened, not once when it is made.
       */
      allowAll?: boolean;
    };
    result: void;
  };
  /**
   * Bring the Copilot CLI up to date, if the reader has asked for that.
   *
   * The CLI updates itself on startup by default and this app never gets that: the SDK
   * spawns it with `--no-auto-update` every time, which is not ours to change. So asking
   * is the only way to have a current one (#199).
   *
   * Answers what happened rather than throwing. Nothing depends on the result, and an
   * update that could not run is not a reason to interrupt anybody.
   */
  'runtime.update': { params: Record<string, never>; result: { ran: boolean; said?: string; failed?: string } };
  'sessions.load': { params: { sessionId: string }; result: void };  'sessions.evict': { params: { sessionId: string }; result: void };  /**
   * Delete a session, or put it in the bin for as long as the reader asked for.
   *
   * With no retention the CLI deletes the session's state directory, which is where the
   * transcript, the checkpoints and the rewind snapshots all live, and there is no undo.
   * With one, that directory is moved into this app's own recycle bin instead and the CLI
   * is not told: it lists sessions by reading that directory, so one that has moved is one
   * it does not have.
   *
   * Either way the row in the history database is left behind, and the sidebar already
   * hides a row whose log has gone - which is why a restored session comes back with its
   * title and its place in the list intact.
   */
  'sessions.delete': { params: { sessionId: string }; result: void };
  /**
   * Copy a session's history into a new one, leaving the original alone.
   *
   * Costs a resume, and has to: forking a session the CLI is not holding rewrites the
   * original's log down to the fork notice alone, losing every event behind it and leaving
   * something that cannot be reopened (#196). So the source is loaded first, and a source
   * that cannot be loaded is refused rather than forked.
   */
  'sessions.fork': { params: { sessionId: string; name?: string }; result: { sessionId: string } };
  /**
   * Which sessions said something, and the words around where they said it.
   *
   * Costs no session: read from the FTS5 index the CLI already maintains, in single-digit
   * milliseconds, so the sidebar can ask on a keystroke. Only sessions the CLI has indexed
   * can be found, which is every session with content bar a handful (#30).
   */
  'sessions.search': { params: { query: string }; result: { matches: SessionMatch[] } };
  /**
   * Where to open a session so a match is on the page, as a cursor to read back from.
   *
   * Costs no session: the moment comes from the CLI's database and the log is halved rather
   * than scanned, so this is a dozen small reads whatever the log's size. Null when the log
   * does not reach that far, which a truncated one will not (#30).
   */
  'sessions.locate': { params: { sessionId: string; source: string }; result: { cursor: number | null } };
  /** What is in the recycle bin, newest first. Costs no session: it is read from disk. */
  'bin.list': { params: Record<string, never>; result: BinnedSession[] };
  /**
   * Put a binned session back where the CLI looks for it.
   *
   * Answers whether it went back. It will not when something is already there under that
   * id, which would be a live session being replaced by an older copy of itself.
   */
  'bin.restore': { params: { sessionId: string }; result: { restored: boolean } };
  /** Delete a binned session for good, without waiting for its retention to run out. */
  'bin.purge': { params: { sessionId: string }; result: void };
  /**
   * What every session is using on disk, largest first.
   *
   * Asked for rather than sent with the session list: it walks every session directory
   * there has ever been, which is a quarter of a second here and not something to pay for
   * on every refresh of a sidebar that never shows it.
   */
  'sessions.disk': { params: void; result: { sessions: SessionDisk[] } };
  /**
   * The CLI's own settings: what it knows about, and what it is set to.
   *
   * Both together, because they are read together and neither is useful alone - a schema
   * with no values draws empty controls, and values with no schema are strings nobody can
   * say the shape of.
   *
   * `values` holds only what the reader has actually chosen. A setting missing from it is
   * one the CLI is deciding for itself, which is not the same as one set to false.
   */
  'cliSettings.list': { params: Record<string, never>; result: { settings: CliSetting[]; values: Record<string, unknown> } };
  /**
   * What the CLI is set to, without what it knows about.
   *
   * Its own half of the pair above, because the two cost wildly different amounts: the
   * values are a small JSON file, while the schema means reading a 90MB binary. The app
   * wants the values as it starts - some of them decide what the transcript draws - and
   * wants the schema only when somebody opens the settings window.
   */
  'cliSettings.values': { params: Record<string, never>; result: Record<string, unknown> };
  /**
   * Change some of the CLI's settings, leaving the rest of its file alone.
   *
   * Merged rather than replaced: the file holds things this app never shows, and writing
   * only what this window knows about would throw those away. Null removes a key, which is
   * how a setting goes back to whatever the CLI would have done by itself.
   *
   * Takes effect without restarting anything. The CLI reads its settings when a session is
   * created rather than when its server starts, so the next session gets them.
   */
  'cliSettings.write': { params: { changes: Record<string, unknown> }; result: void };
  /**
   * Let this session work in a directory without being asked about it each time (#210).
   *
   * Not only an access decision: the runtime also loads any `.github/skills/` and
   * `.github/agents/` found under it, so allowing a directory trusts what is configured
   * there. Whatever offers this has to say so.
   */
  'sessions.allowFolder': { params: { sessionId: string; path: string }; result: { allowed: boolean } };
  'sessions.resolvePermission': { params: ResolvePermissionParams; result: void };
  'sessions.resolveElicitation': { params: ResolveElicitationParams; result: void };
  'sessions.resolvePlan': { params: ResolvePlanParams; result: void };
  'sessions.create': {
    params: {
      workingDirectory?: string;
      /**
       * The permission mode to put the new session in, if not the one it starts in.
       *
       * Set after creation rather than passed to it: the runtime owns this, and giving the
       * CLI `--allow-all` when the shared server is spawned does nothing for the sessions
       * it goes on to create - tested, and they come back `manual` either way (#199).
       */
      allowAll?: boolean;
      /**
       * The model to start on. Absent leaves the runtime's own choice, which is `auto`.
       *
       * Given at creation rather than set afterwards, unlike the permission mode: this is
       * a field the runtime's own session config already takes (#200).
       */
      model?: string;
      /**
       * How hard it thinks and how much room it has, for the model named above.
       *
       * Only meaningful alongside one: applied to whatever the runtime chose instead, they
       * would be answering a question nobody asked.
       */
      reasoningEffort?: ReasoningEffort;
      contextTier?: ContextTier;
    };
    result: { sessionId: string };
  };
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
  /**
   * The turns this session could be put back to (#156).
   *
   * Needs the session open, unlike the changes above: the runtime answers this from the
   * live session rather than from the snapshots on disk. So asking costs a resume, and it
   * is asked when somebody opens the panel rather than kept up to date.
   */
  'sessions.rewindPoints': {
    params: { sessionId: string };
    result: { points: RewindPoint[]; unavailable?: RewindUnavailable };
  };
  /** What going back to that turn would put back, before anything is done. */
  'sessions.previewRewind': { params: { sessionId: string; eventId: string }; result: RewindPreview };
  /**
   * Put the session back to that turn.
   *
   * `files` says whether to restore what the discarded turns changed. The conversation is
   * discarded either way - that is what rewinding is - and it does not come back.
   */
  'sessions.rewind': {
    params: { sessionId: string; eventId: string; files: boolean };
    result: RewindResult;
  };
  'git.state': { params: { cwd: string }; result: { state: TreeState | null } };
  /**
   * The full state of a working tree: branch, upstream, and every path with a change.
   *
   * Reads git directly rather than the session, so it answers for a session nobody has
   * opened and costs no Copilot process. Null when the directory is not in a repository.
   */
  'git.status': { params: { cwd: string }; result: { status: RepoStatus | null } };
  /**
   * The diff for one path, on the side asked about.
   *
   * Staged compares the index against HEAD; unstaged compares the working tree against the
   * index. A file can be in both lists with different contents in each, so which one is
   * wanted has to be said rather than guessed.
   */
  'git.diff': { params: { cwd: string; path: string; staged: boolean }; result: { diff: FileDiff } };
  /**
   * Put one path's changes into the index, or take them back out.
   *
   * Answers with the tree as it stands afterwards, so the panel redraws from what git says
   * rather than from what it assumed would happen.
   *
   * Unstaging never touches the working tree: it is written with `update-index`, which has
   * no way to write a file, rather than with `reset` or `restore`, which do.
   */
  'git.stage': { params: { cwd: string; paths: string[]; staged: boolean }; result: { status: RepoStatus | null } };
  /**
   * Commit what is staged, or amend the commit at HEAD.
   *
   * Runs git as the reader would, so the repository's hooks and signing configuration apply.
   * Amending is refused once the commit has been pushed: rewriting history others may have
   * is the one irreversible thing this panel could do.
   */
  'git.commit': {
    params: { cwd: string; message: string; amend: boolean };
    result: { status: RepoStatus | null };
  };
  /**
   * Send the current branch to its remote, or bring the remote's work down onto it.
   *
   * There is no force, and no option that could become one.
   *
   * How a pull reconciles two branches that have both moved on is the CLI's `mergeStrategy`,
   * read from the repository's settings before the reader's own (#205). Unset, the pull is
   * fast-forward only and answers `diverged` rather than choosing for somebody - which is
   * what the CLI does too, asking rather than assuming, since it has no default either.
   */
  'git.sync': {
    params: { cwd: string; direction: 'push' | 'pull'; strategy?: MergeStrategy };
    result: { status: RepoStatus | null; diverged?: boolean };
  };
  /** The local branches, and which one is checked out. */
  'git.branches': { params: { cwd: string }; result: { branches: { name: string; current: boolean }[] } };
  /**
   * Check out a branch, or make one and check it out.
   *
   * Uncommitted work is left to git, which carries it across when it can and refuses when a
   * file would be overwritten - a better check than anything here could make, because it
   * knows which files are in the way.
   */
  'git.switch': {
    params: { cwd: string; name: string; create: boolean };
    result: { status: RepoStatus | null };
  };
  'models.list': { params: void; result: { models: ModelChoice[] } };
  /**
   * The slash commands there are.
   *
   * Takes a session because a loaded one knows about a few more than the runtime does in
   * general - the ones that only mean something inside a conversation, such as /compact -
   * but never resumes one to find out.
   */
  'commands.list': { params: { sessionId?: string }; result: { commands: SlashCommand[] } };
  /**
   * Child directories of a path being completed in the composer.
   *
   * Reads the local filesystem in the sidecar. It never starts or resumes Copilot.
   */
  'filesystem.directories': {
    params: { cwd?: string; path: string };
    result: { entries: string[]; separator: string; caseSensitive: boolean };
  };
  /**
   * Every page in the local knowledge base, for the browser's tree.
   *
   * A directory walk and one read of the prebuilt index. Like the session list, it costs no
   * Copilot process: the wiki is files, and reading files is all this does.
   *
   * Says where it looked and whether anything is there, so a machine with no wiki can be
   * told what one is rather than shown an empty tree.
   */
  'wiki.pages': { params: void; result: { pages: WikiPage[]; root: string; exists: boolean } };
  /** One page, by its path relative to the wiki root. Null for anything outside it. */
  'wiki.page': { params: { path: string }; result: { page: WikiPageContent | null } };
  /**
   * Write a page back as it was edited, over one that is already there.
   *
   * False when it could not be written: outside the wiki, gone, or read-only. The whole file
   * is sent, because the editor holds the file rather than a view of it.
   */
  'wiki.save': { params: { path: string; source: string }; result: { saved: boolean } };
  /**
   * Start a knowledge base where one was expected, and answer with the page to open.
   *
   * Makes the folder if it is missing and writes a first page if there is none. Null when
   * nothing could be made. Never overwrites a page that is already there.
   */
  'wiki.create': { params: void; result: { page: string | null } };
  /** The pages answering a query, best first, ranked as the wiki's own search script ranks. */
  'wiki.search': { params: { query: string; limit?: number }; result: { results: WikiSearchResult[] } };
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
   * Turn an MCP server on or off for sessions started from now on.
   *
   * Sessionless, like discovering them: the disabled list is the reader's own configuration
   * rather than anything about a conversation. A session already running keeps the servers
   * it connected to, which is the runtime's behaviour and not something this can change.
   */
  'mcp.setEnabled': { params: { name: string; enabled: boolean }; result: void };
  /**
   * The MCP servers there are, for completing the name a command wants.
   *
   * The same discovery the environment panel uses, on its own so that finishing a command
   * does not have to fetch the instructions, plugins, extensions and skills beside it.
   */
  'mcp.servers': { params: { cwd?: string }; result: { servers: McpServerSummary[] } };
  /**
   * Write a server into the reader's own config, or change one already there.
   *
   * Costs no session: the config is a file rather than anything a conversation holds.
   */
  'mcp.save': { params: { name: string; config: McpServerConfig }; result: void };
  /** Take a server out of the reader's own config. */
  'mcp.remove': { params: { name: string }; result: void };
  /**
   * What each MCP server is actually doing in a session.
   *
   * Null for a session that is not loaded, which is not a failure: only a session that has
   * tried to connect can say whether it worked, and browsing what a directory offers must
   * not cost a resume. The same rule `sessions.usage` follows (#24).
   */
  'mcp.status': { params: { sessionId: string }; result: { servers: McpServerState[] | null } };
  /**
   * Begin signing in to a server that is waiting for it.
   *
   * Answers with the page to send the reader to, which this app opens in their browser. The
   * runtime holds the other end and says so through `session.mcp_oauth_completed`.
   */
  'mcp.login': { params: { sessionId: string; name: string }; result: { authorizationUrl: string | null } };
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
  /** How full the window is. Null for a session that is not loaded, which is not resumed to ask. */
  'sessions.context': { params: { sessionId: string }; result: { usage: SessionContextUsage | null } };
  /**
   * What a session has spent.
   *
   * Answered from a loaded session when there is one and from its last usage checkpoint
   * when there is not, so this never resumes anything. Null only when the log has no
   * checkpoint yet, which is a session that has not finished a turn.
   */
  'sessions.usage': { params: { sessionId: string }; result: { usage: SessionUsage | null } };
  'sessions.model': { params: { sessionId: string }; result: { current: SessionModel | null } };
  'sessions.setModel': {
    params: { sessionId: string; model: string; reasoningEffort?: ReasoningEffort; contextTier?: ContextTier };
    result: void;
  };
  /**
   * How a session is working. Read from the log when it is not loaded, so asking is cheap.
   *
   * Always an answer rather than null: a session with nothing to say about its mode is in
   * the one it opened in, which is `interactive`.
   */
  'sessions.mode': { params: { sessionId: string }; result: { mode: SessionMode } };
  /**
   * Puts a session into a mode, answering with the one the runtime actually applied.
   *
   * The notice is the runtime's own prose about the switch, which is worth passing on
   * mainly because entering plan mode can change the model the session runs on.
   */
  'sessions.setMode': {
    params: { sessionId: string; mode: SessionMode };
    result: { mode: SessionMode; notice?: string };
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
  /**
   * The contract the answering sidecar was built against.
   *
   * Asked before anything else, because the answer decides whether the rest can be
   * believed. A sidecar too old to have this method says so by not having it, which is
   * the one error message in the whole protocol that means exactly what it says.
   */
  'protocol.version': { params: void; result: { version: string } };
}

/**
 * Every method there is, as values rather than as types.
 *
 * `SidecarMethod` used to be `keyof SidecarRequests`, which exists only while the compiler
 * is running. Nothing could therefore ask at runtime what the contract was, and the two
 * halves of this app ship separately: the frontend is replaced in place by Vite, the
 * sidecar is a Node process started once from its own build. Either can be older than the
 * other with nothing to say so (#169).
 *
 * Listed by hand and checked by the compiler from both ends. A name here that is not in
 * `SidecarRequests` fails to resolve its parameters; a method there that is missing here is
 * not part of `SidecarMethod`, so nothing can call it and no handler is required for it.
 * Forgetting to add one therefore fails closed rather than silently leaving a method out of
 * the version below.
 */
export const SIDECAR_METHODS = [
  'sessions.list',
  'sessions.find',
  'sessions.exist',
  'sessions.transcript',
  'sessions.agentTranscript',
  'sessions.send',
  'sessions.abort',
  'sessions.shell',
  'sessions.cancelShell',
  'sessions.rename',
  'runtime.limits',
  'runtime.update',
  'sessions.load',
  'sessions.evict',
  'sessions.delete',
  'sessions.fork',
  'sessions.search',
  'sessions.locate',
  'bin.list',
  'bin.restore',
  'bin.purge',
  'sessions.disk',
  'cliSettings.list',
  'cliSettings.values',
  'cliSettings.write',
  'sessions.allowFolder',
  'sessions.resolvePermission',
  'sessions.resolveElicitation',
  'sessions.resolvePlan',
  'sessions.create',
  'sessions.changes',
  'sessions.diff',
  'sessions.rewindPoints',
  'sessions.previewRewind',
  'sessions.rewind',
  'git.state',
  'git.status',
  'git.diff',
  'git.stage',
  'git.commit',
  'git.sync',
  'git.branches',
  'git.switch',
  'models.list',
  'commands.list',
  'filesystem.directories',
  'wiki.pages',
  'wiki.page',
  'wiki.save',
  'wiki.create',
  'wiki.search',
  'commands.invoke',
  'commands.enqueue',
  'agents.list',
  'agents.current',
  'agents.select',
  'agents.deselect',
  'environment.describe',
  'mcp.setEnabled',
  'mcp.servers',
  'mcp.save',
  'mcp.remove',
  'mcp.status',
  'mcp.login',
  'skills.disabled',
  'skills.set',
  'sessions.queue',
  'sessions.context',
  'sessions.usage',
  'sessions.model',
  'sessions.setModel',
  'sessions.mode',
  'sessions.setMode',
  'runtime.status',
  'attachments.stash',
  'attachments.preview',
  'protocol.version',
] as const;

export type SidecarMethod = (typeof SIDECAR_METHODS)[number];

/** FNV-1a, for a short stable digest of the method list. Not security, just difference. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * What the two halves compare at connect.
 *
 * Derived from the method names rather than written down, because a number somebody has to
 * remember to raise is a number that will be forgotten exactly when it matters. Adding,
 * removing or renaming a method changes this without anyone thinking about it, and those
 * are precisely the changes that produce `Unknown method` against a stale build.
 *
 * Sorted first, so reordering the list above is not mistaken for a change to the contract.
 *
 * It says nothing about the shape of any method's parameters or result. Those are types and
 * are gone by runtime, so a changed shape still crosses silently; this covers the drift that
 * can be seen from here rather than pretending to cover all of it.
 */
export function protocolVersionOf(methods: readonly string[]): string {
  return digest([...methods].sort().join('\n'));
}

export const PROTOCOL_VERSION = protocolVersionOf(SIDECAR_METHODS);

/** Notifications the sidecar pushes to the frontend. */
export interface SessionEventNotification {
  sessionId: string;
  event: TranscriptEvent;
}

export interface SessionLoadedNotification {
  sessionId: string;
  loaded: boolean;
  /**
   * A resume in flight, which is neither loaded nor not.
   *
   * Reported because it is the one of the three that takes long enough to be worth drawing:
   * the reader who asked for it is watching the row they asked about, and a row that sits
   * still reads as nothing having happened.
   */
  loading?: boolean;
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

/** Sent when a plan is approved, turned down or abandoned, so the UI can clear it. */
export interface PlanResolvedNotification {
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
export const NOTIFY_PLAN_REQUESTED = 'plan.requested';
export const NOTIFY_PLAN_RESOLVED = 'plan.resolved';

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

/**
 * One path git has something to say about.
 *
 * Both halves at once, because a file can be staged and then modified again - which a reader
 * needs to see as one row rather than as two files with the same name.
 */
export interface RepoFile {
  path: string;
  /** What the index holds against HEAD. Absent when the index matches HEAD. */
  staged?: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  /** What the working tree holds against the index. Absent when they match. */
  unstaged?: 'modified' | 'deleted' | 'untracked' | 'unmerged' | 'typechange';
  /** Where a rename or copy came from, which is half of what the row means. */
  from?: string;
}

/**
 * How a pull reconciles two branches that have both moved on.
 *
 * The CLI's `mergeStrategy`, which has no default: unset, the CLI asks rather than assuming,
 * and so does this. Its own use for it is `/pr`, choosing which prompt to give the agent for
 * resolving conflicts with a base branch - the same question a pull asks (#205).
 */
export type MergeStrategy = 'rebase' | 'merge';

/**
 * The state of a working tree, as a source control panel shows it.
 *
 * Null when the directory is not in a repository, which is a normal thing for a session to
 * be in rather than a failure: plenty of work happens in folders nobody has run `git init`
 * in, and this app exists partly to serve them.
 */
export interface RepoStatus {
  /** The branch name, or the short commit when HEAD is detached. */
  branch: string;
  detached: boolean;
  /** The branch it tracks, when it tracks one. */
  upstream?: string;
  /** How far ahead and behind that upstream. Both zero when there is none. */
  ahead: number;
  behind: number;
  files: RepoFile[];
}

/**
 * Whether the commit at HEAD can still be amended.
 *
 * Amending is the one irreversible thing the source control panel offers, so the rule lives
 * here rather than on either side of the wire: the panel hides the option and the sidecar
 * refuses the operation, and they must not be able to disagree about when.
 *
 * Safe when the branch is ahead of its upstream, or has no upstream at all. In both cases
 * nothing downstream has seen the commit yet.
 */
export function canAmend(status: RepoStatus | null): boolean {
  if (!status) return false;
  return status.upstream === undefined || status.ahead > 0;
}
