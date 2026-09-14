import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type {
  AgentSummary,
  CommandOutcome,
  ContextTier,
  ElicitationAction,
  ElicitationFieldValue,
  ElicitationResolvedNotification,
  FileDiff,
  GetTranscriptResult,
  ListSessionsResult,
  ModelChoice,
  PendingElicitation,
  PendingPermission,
  PermissionChoice,
  PermissionResolvedNotification,
  SessionEnvironment,
  ReasoningEffort,
  RuntimeStatus,
  SendParams,
  SendResult,
  SessionEventNotification,
  SessionChange,
  SessionLoadedNotification,
  SessionChangesNotification,
  SessionAgent,
  SessionModel,
  ShellResult,
  QueuedItem,
  SidecarMethod,
  SidecarRequests,
  SlashCommand,
  StashParams,
  TreeState,
} from '../../shared/protocol';

/**
 * Single entry point for every sidecar call, so transport details stay in one place.
 *
 * Typed against the shared table rather than against a bare string: the method name and its
 * parameters cross a process boundary, where nothing checks them, so a rename on one side
 * used to be found by running the app rather than by building it. The result type comes from
 * the same table, which is why no call site below states one.
 *
 * The rest parameter is how a method that takes nothing is called with nothing: a plain
 * optional argument would let every other call omit its parameters too.
 */
async function request<M extends SidecarMethod>(
  method: M,
  ...[params]: SidecarRequests[M]['params'] extends void ? [] : [SidecarRequests[M]['params']]
): Promise<SidecarRequests[M]['result']> {
  return invoke('sidecar_request', { method, params: params ?? null });
}

/** Reads the sidebar model from session-store.db. Spawns no Copilot process. */
export function listSessions(): Promise<ListSessionsResult> {
  return request('sessions.list');
}

/**
 * Sessions whose id starts with this, including ones the list hides.
 *
 * Separate from the list because it reaches rows the list deliberately drops - crashed
 * starts with no title and no turns - and because paying for them on every refresh would
 * roughly double its cost for results nobody normally looks at.
 */
export function findSessions(prefix: string): Promise<ListSessionsResult> {
  return request('sessions.find', { prefix });
}

/** Which of these sessions still exist on disk. Reads directory entries; starts no process. */
export function existingSessions(sessionIds: string[]): Promise<string[]> {
  return request('sessions.exist', { sessionIds }).then((r) => r.sessionIds);
}

/** What the runtime is holding. Reports only; starts no process. */
export function runtimeStatus(): Promise<RuntimeStatus> {
  return request('runtime.status');
}

/** The models this account may use. Starts the shared server, so it is asked for lazily. */
export async function listModels(): Promise<ModelChoice[]> {
  const { models } = await request('models.list');
  return models;
}

/**
 * The slash commands there are. Starts the shared server, so it is asked for lazily.
 *
 * A loaded session is asked in preference to the runtime at large, since it knows about the
 * few that only mean something inside a conversation. A cold one is never resumed for this.
 */
export async function listCommands(sessionId?: string): Promise<SlashCommand[]> {
  const { commands } = await request('commands.list', { sessionId });
  return commands;
}

/** Run a slash command in a session, resuming it if it is cold. */
export async function invokeCommand(
  sessionId: string,
  name: string,
  input?: string,
): Promise<CommandOutcome> {
  const { outcome } = await request('commands.invoke', {
    sessionId,
    name,
    input,
  });
  return outcome;
}

/**
 * Queue a command behind the running turn rather than refusing it.
 *
 * False means the session does not queue locally, which is the one case worth handling
 * rather than assuming.
 */
export async function enqueueCommand(
  sessionId: string,
  command: string,
  displayText?: string,
): Promise<boolean> {
  const { queued } = await request('commands.enqueue', {
    sessionId,
    command,
    displayText,
  });
  return queued;
}

/** The runtime's own queue. Empty for a session that is not loaded, which is not resumed to ask. */
export async function sessionQueue(sessionId: string): Promise<QueuedItem[]> {
  const { items } = await request('sessions.queue', { sessionId });
  return items;
}

/** What a session runs on, read from its log. Costs no Copilot process. */
export async function sessionModel(sessionId: string): Promise<SessionModel | null> {
  const { current } = await request('sessions.model', { sessionId });
  return current;
}

/** Change the model a session uses from its next message on. Resumes it if it is cold. */
export function setSessionModel(
  sessionId: string,
  model: string,
  reasoningEffort?: ReasoningEffort,
  contextTier?: ContextTier,
): Promise<void> {
  return request('sessions.setModel', { sessionId, model, reasoningEffort, contextTier });
}

/**
 * The custom agents there are. Starts the shared server, so it is asked for lazily.
 *
 * A directory narrows this to the agents that project defines as well as the reader's own.
 * No session is resumed either way: which agents exist is a question about the machine.
 */
export async function listAgents(cwd?: string): Promise<AgentSummary[]> {
  const { agents } = await request('agents.list', { cwd });
  return agents;
}

/** Which agent a session is on, read from its log. Null is the default agent. */
export async function sessionAgent(sessionId: string): Promise<SessionAgent | null> {
  const { agent } = await request('agents.current', { sessionId });
  return agent;
}

/** Put a session on an agent from its next message on. Resumes it if it is cold. */
export function selectAgent(sessionId: string, name: string): Promise<void> {
  return request('agents.select', { sessionId, name });
}

/** Return a session to the default agent. Resumes it if it is cold. */
export function deselectAgent(sessionId: string): Promise<void> {
  return request('agents.deselect', { sessionId });
}

/**
 * What a session in this directory would load: instructions, plugins and extensions.
 *
 * Answered from disk and the server, never from a session, so this works for one the app
 * has never opened and costs no resume.
 */
export function describeEnvironment(cwd?: string): Promise<SessionEnvironment> {
  return request('environment.describe', { cwd });
}

/** The skills this session has switched off. Read from the app's own record, so it costs no process. */
export function disabledSkills(sessionId: string): Promise<{ disabled: string[] }> {
  return request('skills.disabled', { sessionId });
}

/** Switch one skill on or off for one session, and get back everything that is now off. */
export function setSkillEnabled(sessionId: string, name: string, enabled: boolean): Promise<{ disabled: string[] }> {
  return request('skills.set', { sessionId, name, enabled });
}

/** What git says about a directory now. Null when it is not in a repository. */
export async function gitState(cwd: string): Promise<TreeState | null> {
  const { state } = await request('git.state', { cwd });
  return state;
}

/** Replays a session transcript from events.jsonl without resuming it. */
export function getTranscript(
  sessionId: string,
  limit?: number,
  before?: number,
): Promise<GetTranscriptResult> {
  return request('sessions.transcript', { sessionId, limit, before });
}

/**
 * What a session changed, from its rewind snapshots. Costs no Copilot process.
 *
 * The same store the CLI reads for its own rewind, so a session worked on in either tool
 * gives the same answer in both.
 *
 * With `since`, only the turns after that snapshot timestamp are read.
 */
export function getChanges(sessionId: string, since?: string): Promise<{ changes: SessionChange[] }> {
  return request('sessions.changes', { sessionId, since });
}

/** The diff for one of those files, over the same span the list was built with. */
export function getDiff(sessionId: string, path: string, since?: string): Promise<FileDiff> {
  return request('sessions.diff', { sessionId, path, since });
}

/** Starts a session in a directory. Costs a Copilot process, like sending does. */
export function createSession(workingDirectory?: string): Promise<{ sessionId: string }> {
  return request('sessions.create', { workingDirectory });
}

/** Resumes the session if it is cold, then sends. This is the only call that costs memory. */
export function sendMessage(params: SendParams): Promise<SendResult> {
  return request('sessions.send', params);
}

/**
 * Write a pasted file beside the session's record and hand back its path.
 *
 * Costs nothing: a disk write in the sidecar, not a Copilot process. Only paths can be
 * attached to a message, and clipboard content has none.
 */
export async function stashPaste(params: StashParams): Promise<string> {
  const { path } = await request('attachments.stash', params);
  return path;
}

/**
 * An image as a data URL, for a file the webview has no way to load itself.
 *
 * Null for anything that is not a readable image within the size limit, since a preview
 * that does not appear is the entire consequence.
 */
export async function previewImage(path: string): Promise<string | null> {
  const { dataUrl } = await request('attachments.preview', { path });
  return dataUrl;
}

export function abortSession(sessionId: string): Promise<void> {
  return request('sessions.abort', { sessionId });
}

/**
 * Run a shell command the reader typed, in the session's own shell.
 *
 * The runtime emits it as a tool call, so the transcript shows it like any other and the
 * agent has its output in context afterwards. The returned result is the answer to this
 * request; `requestId` is the handle for cancelling it.
 */
export function runShell(sessionId: string, requestId: string, command: string): Promise<ShellResult> {
  return request('sessions.shell', { sessionId, requestId, command });
}

/** Stop a shell command started by `runShell`. Does not touch the agent's turn. */
export function cancelShell(sessionId: string, requestId: string): Promise<void> {
  return request('sessions.cancelShell', { sessionId, requestId });
}

/** Answer a pending tool permission request, unblocking the agent. */
export function resolvePermission(
  sessionId: string,
  requestId: string,
  choice: PermissionChoice,
): Promise<void> {
  return request('sessions.resolvePermission', { sessionId, requestId, choice });
}

/** Live session events forwarded from the sidecar. */
export function onSessionEvent(handler: (payload: SessionEventNotification) => void) {
  return listen<SessionEventNotification>('session-event', (e) => handler(e.payload));
}

/** Notifies that a session is resumed into, or released from, memory. */
export function onSessionLoaded(handler: (payload: SessionLoadedNotification) => void) {
  return listen<SessionLoadedNotification>('session-loaded', (e) => handler(e.payload));
}

/** A turn wrote down what it changed, so anything showing that list should read it again. */
export function onSessionChanges(handler: (payload: SessionChangesNotification) => void) {
  return listen<SessionChangesNotification>('session-changes', (e) => handler(e.payload));
}

/** The session store changed, so the sidebar should refetch. */
export function onSessionsChanged(handler: () => void) {
  return listen('sessions-changed', () => handler());
}

/**
 * The sidecar exited. Every session is gone with it and nothing will answer again, so
 * this is reported rather than left to look like an app that has simply gone quiet.
 */
export function onSidecarStopped(handler: (reason: string) => void) {
  return listen<string>('sidecar-stopped', (event) => handler(event.payload));
}

/** Another sidecar took over from one that died. Anything it was told is gone. */
export function onSidecarRestarted(handler: () => void) {
  return listen('sidecar-restarted', () => handler());
}

/** A tool call is waiting on the user before it can run. */
export function onPermissionRequested(handler: (payload: PendingPermission) => void) {
  return listen<PendingPermission>('permission-requested', (e) => handler(e.payload));
}

/** A pending request was answered or abandoned and should no longer be shown. */
export function onPermissionResolved(handler: (payload: PermissionResolvedNotification) => void) {
  return listen<PermissionResolvedNotification>('permission-resolved', (e) => handler(e.payload));
}

/** The agent is asking the user a question and is blocked until it is answered. */
export function onElicitationRequested(handler: (payload: PendingElicitation) => void) {
  return listen<PendingElicitation>('elicitation-requested', (e) => handler(e.payload));
}

export function onElicitationResolved(handler: (payload: ElicitationResolvedNotification) => void) {
  return listen<ElicitationResolvedNotification>('elicitation-resolved', (e) => handler(e.payload));
}

/** Answer a question from the agent, unblocking it. */
export function resolveElicitation(
  requestId: string,
  action: ElicitationAction,
  content?: Record<string, ElicitationFieldValue>,
): Promise<void> {
  return request('sessions.resolveElicitation', { requestId, action, content });
}
