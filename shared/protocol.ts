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
  /** Present on replayed events only; live events are timestamped on arrival. */
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
  /** Maximum concurrently loaded sessions before LRU eviction kicks in. */
  maxLoadedSessions: number;
}

export interface SendParams {
  sessionId: string;
  prompt: string;
  /** `enqueue` queues behind an in-flight turn instead of starting a new one. */
  mode?: 'enqueue' | 'immediate';
}

export interface SendResult {
  messageId: string;
}

export interface SetApprovalPolicyParams {
  sessionId: string;
  policy: 'prompt' | 'approve-all';
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

/** Requests the frontend may issue. */
export interface SidecarRequests {
  'sessions.list': { params: void; result: ListSessionsResult };
  'sessions.transcript': { params: GetTranscriptParams; result: GetTranscriptResult };
  'sessions.send': { params: SendParams; result: SendResult };
  'sessions.abort': { params: { sessionId: string }; result: void };
  'sessions.evict': { params: { sessionId: string }; result: void };
  'sessions.setApprovalPolicy': { params: SetApprovalPolicyParams; result: void };
  'sessions.resolvePermission': { params: ResolvePermissionParams; result: void };
  'sessions.resolveElicitation': { params: ResolveElicitationParams; result: void };
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
