import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type {
  AgentSummary,
  Attachment,
  BinnedSession,
  CliSetting,
  CommandOutcome,
  ContextTier,
  ElicitationAction,
  ElicitationFieldValue,
  ElicitationResolvedNotification,
  DelegatedTask,
  FileDiff,
  GetTranscriptResult,
  TranscriptEvent,
  ListSessionsResult,
  SessionMatch,
  McpServerConfig,
  McpServerState,
  RewindPoint,
  RewindPreview,
  RewindResult,
  RewindUnavailable,
  McpServerSummary,
  MergeStrategy,  ModelChoice,
  RepoStatus,
  SessionDisk,
  Dropped,
  Todo,
  PendingElicitation,
  PendingPermission,
  PendingPlanApproval,
  PermissionChoice,
  PermissionResolvedNotification,
  PlanAction,
  PlanResolvedNotification,
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
  SessionContextUsage,
  SessionModel,
  SessionMode,
  SessionUsage,
  ShellResult,
  QueuedItem,
  SidecarMethod,
  SidecarRequests,
  SlashCommand,
  StashParams,
  TreeState,
  WikiPage,
  WikiPageContent,
  WikiSearchResult,
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

/**
 * Bring a session into memory before anything is asked of it.
 *
 * Costs a resume, which is the thing this app otherwise refuses to pay until it has to. Paid
 * deliberately here, by somebody who knows they are about to use it.
 */
/**
 * Tell the runtime what may stay in memory.
 *
 * Sent whenever it changes and once at startup: the runtime begins every run on its own
 * defaults and has no memory of what was chosen last time.
 */
/**
 * Bring the Copilot CLI up to date.
 *
 * The CLI updates itself on startup by default and this app never gets that: the SDK spawns
 * it with `--no-auto-update` every time. Asking is the only way to have a current one.
 */
export function updateCli(): Promise<{ ran: boolean; said?: string; failed?: string }> {
  return request('runtime.update', {});
}

export function setRuntimeLimits(
  maxLoadedSessions: number,
  idleTimeoutMs: number,
  binRetentionDays?: number,
  permissionTimeoutMs?: number,
  allowAll?: boolean,
): Promise<void> {
  return request('runtime.limits', {
    maxLoadedSessions,
    idleTimeoutMs,
    binRetentionDays,
    permissionTimeoutMs,
    allowAll,
  });
}

export function renameSession(sessionId: string, name: string): Promise<void> {
  return request('sessions.rename', { sessionId, name });
}

export function loadSession(sessionId: string): Promise<void> {
  return request('sessions.load', { sessionId });
}

/**
 * Let a session go now rather than waiting out the idle timer.
 *
 * Frees what it holds without touching anything on disk: the transcript, the rewind store
 * and the database are the CLI's and are untouched, so the session opens again from the log
 * exactly as it would have. Refused while a turn is running, which the caller is expected to
 * have ruled out rather than discovered here (#107).
 */
export function evictSession(sessionId: string): Promise<void> {
  return request('sessions.evict', { sessionId });
}

/**
 * Remove a session and everything it wrote. There is no undo.
 *
 * The caller is expected to have asked first: nothing here confirms anything, and the CLI
 * destroys the session's state directory the moment this is called.
 */
export function deleteSession(sessionId: string): Promise<void> {
  return request('sessions.delete', { sessionId });
}

/**
 * Copy a session's history into a new one, leaving the original alone.
 *
 * Costs a resume, which the caller should say before asking for it. The sidecar loads the
 * source first and refuses outright when it cannot, because forking a session the CLI is
 * not holding empties the original instead of copying it (#196).
 */
export async function forkSession(sessionId: string, name?: string): Promise<string> {
  const { sessionId: made } = await request('sessions.fork', { sessionId, name });
  return made;
}

/**
 * Which sessions said something, and the words around where they said it.
 *
 * Costs no session and no new index: it reads the FTS5 table the CLI already keeps, in
 * single-digit milliseconds, so the sidebar can ask while somebody is still typing (#30).
 */
export async function searchSessions(query: string): Promise<SessionMatch[]> {
  const { matches } = await request('sessions.search', { query });
  return matches;
}

/**
 * Where to open a session so a turn is on the page, as a cursor to read back from.
 *
 * Costs no session and does not read the log: the turn's time comes from the CLI's database
 * and the log is halved to find it. Null when the log does not reach that turn (#30).
 */
export async function locateTurn(sessionId: string, source: string): Promise<number | null> {
  const { cursor } = await request('sessions.locate', { sessionId, source });
  return cursor;
}

/**
 * Where to open a session so that a moment is the last thing on the page.
 *
 * The same read as `locateTurn`, for a caller that already knows when rather than holding a
 * search result to look up (#225).
 */
export async function locateMoment(sessionId: string, at: string): Promise<number | null> {
  const { cursor } = await request('sessions.locate', { sessionId, at });
  return cursor;
}

/**
 * The tasks a session delegated, newest first, a page at a time (#228).
 *
 * Costs no session: the log is read from disk. Paged because finding every one means
 * reading the whole log, which is seconds on the largest here and milliseconds on a
 * typical one.
 */
export function sessionAgents(
  sessionId: string,
  limit?: number,
  before?: number,
): Promise<{ agents: DelegatedTask[]; truncated: boolean; nextBefore: number | null }> {
  return request('sessions.agents', { sessionId, limit, before });
}

/** What is waiting in the recycle bin, newest first. Costs no session: it is read from disk. */
export function binnedSessions(): Promise<BinnedSession[]> {
  return request('bin.list', {});
}

/**
 * What every session is using on disk, largest first.
 *
 * Costs a walk of every session directory there has ever been - a quarter of a second here -
 * so it is asked for when somebody wants to know rather than kept up to date.
 */
export async function sessionDiskUsage(): Promise<SessionDisk[]> {
  const { sessions } = await request('sessions.disk');
  return sessions;
}

/** Put a binned session back. False means something is already there under that id. */
export async function restoreBinned(sessionId: string): Promise<boolean> {
  const { restored } = await request('bin.restore', { sessionId });
  return restored;
}

/** Delete a binned session for good, rather than waiting out its retention. */
export function purgeBinned(sessionId: string): Promise<void> {
  return request('bin.purge', { sessionId });
}

/** What the CLI is set to, without reading the 90MB binary that says what it knows about. */
export function cliSettingValues(): Promise<Record<string, unknown>> {
  return request('cliSettings.values', {});
}

/** The CLI's own settings: what it knows about, and what the reader has set. */
export function cliSettings(): Promise<{ settings: CliSetting[]; values: Record<string, unknown> }> {
  return request('cliSettings.list', {});
}

/** Change some of the CLI's settings. Null takes a key out, going back to the CLI's default. */
export function writeCliSettings(changes: Record<string, unknown>): Promise<void> {
  return request('cliSettings.write', { changes });
}

/** The runtime is asked what it knows. Costs nothing: the sidecar reads a constant. */
export async function runtimeProtocolVersion(): Promise<string> {
  const { version } = await request('protocol.version');
  return version;
}

/**
 * Throw away the sidecar and let the shell start another from what is on disk now.
 *
 * A Tauri command rather than a sidecar method, because the process being replaced cannot
 * be the one asked to replace it - and a sidecar too old to know the method would refuse
 * exactly when the replacing matters most (#169).
 */
export function restartRuntime(): Promise<void> {
  return invoke('restart_runtime');
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

/**
 * Child directories below the path being completed in the composer.
 *
 * This is a local disk read in the sidecar and never starts or resumes Copilot.
 */
export function listDirectories(
  cwd: string | undefined,
  path: string,
): Promise<{ entries: string[]; separator: string; caseSensitive: boolean }> {
  return request('filesystem.directories', { cwd, path });
}

/** The same read with files included, for a mention being written with `@` (#135). */
export function listEntries(
  cwd: string | undefined,
  path: string,
): Promise<{ entries: { name: string; directory: boolean }[]; separator: string; caseSensitive: boolean }> {
  return request('filesystem.entries', { cwd, path });
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

/**
 * Changing your mind about something already waiting (#76).
 *
 * Each answers with whether anything moved. An entry can be taken by the turn while the
 * call is on its way, and false is what that looks like: the message has gone to the agent
 * rather than anything having failed.
 */
export async function removeQueued(sessionId: string, id: string): Promise<boolean> {
  const { removed } = await request('sessions.queueRemove', { sessionId, id });
  return removed;
}

export async function editQueued(
  sessionId: string,
  id: string,
  text: string,
  attachments?: Attachment[],
): Promise<boolean> {
  const { updated } = await request('sessions.queueEdit', {
    sessionId,
    id,
    text,
    ...(attachments ? { attachments } : {}),
  });
  return updated;
}

export async function moveQueued(sessionId: string, id: string, to: number): Promise<boolean> {
  const { moved } = await request('sessions.queueMove', { sessionId, id, to });
  return moved;
}

export async function clearQueued(sessionId: string): Promise<boolean> {
  const { cleared } = await request('sessions.queueClear', { sessionId });
  return cleared;
}

/**
 * Hand a waiting message to the turn that is already running, rather than the next one.
 *
 * False where there was no running turn to steer into, and the message stays where it was.
 */
export async function steerQueued(sessionId: string, id: string): Promise<boolean> {
  const { steered } = await request('sessions.queueSendNow', { sessionId, id });
  return steered;
}

/**
 * Take back a message that has already been sent.
 *
 * Reaches further than removing a queued one: one that has already started a turn leaves
 * that turn, which is stopped and its events taken off the record. `interrupted` without
 * `removed` means the turn was stopped but the message stays in it, because the model had
 * already answered - so the words are not the caller's to put back.
 */
export function withdrawMessage(
  sessionId: string,
  messageId: string,
): Promise<{ removed: boolean; interrupted: boolean }> {
  return request('sessions.withdraw', { sessionId, messageId });
}

/** Hold the queue where it is, or let it go again. */
export async function holdQueue(sessionId: string, paused: boolean): Promise<boolean> {
  const { held } = await request('sessions.queueHold', { sessionId, paused });
  return held;
}

/**
 * Write a session out as a single file, to move it to another machine (#63).
 *
 * Deflated, so a conversation that is mostly event log travels as a fraction of what it
 * costs on disk.
 */
export async function exportSession(sessionId: string, toPath: string): Promise<number> {
  const { bytes } = await request('sessions.export', { sessionId, toPath });
  return bytes;
}

/** What a session would cost to pack, for a confirmation that names a real number. */
export function exportSize(sessionId: string): Promise<{ files: number; bytes: number }> {
  return request('sessions.exportSize', { sessionId });
}

/** Take a bundle in as a session of its own, under the id it already has (#63). */
export function importSession(fromPath: string): Promise<{ sessionId: string; files: number }> {
  return request('sessions.import', { fromPath });
}

/**
 * Sessions another Copilot has open (#63).
 *
 * Only ones this app has not loaded itself. Two Copilots working in one conversation write
 * to the same log and the same database, and nothing else in the app says it is happening.
 */
export async function activeSessions(): Promise<string[]> {
  const { sessionIds } = await request('sessions.active', {});
  return sessionIds;
}

/**
 * What each of these sessions last said, for the rows on screen (#240).
 *
 * Asked about what a reader can see rather than about the whole list. A disk read of a
 * fixed window, skipped entirely for a log that has not moved, and no Copilot process.
 */
export async function sessionPreviews(sessionIds: string[]): Promise<Record<string, string>> {
  const { previews } = await request('sessions.previews', { sessionIds });
  return previews;
}

/**
 * The agent's own todo list (#172).
 *
 * Empty for a session that is not loaded, which is not resumed to ask. The list lives in
 * the running session's database, and the event that announces a change is ephemeral, so a
 * cold session has nothing to replay either.
 */
export async function sessionTodos(sessionId: string): Promise<Todo[]> {
  const { todos } = await request('sessions.todos', { sessionId });
  return todos;
}

/** What a session runs on, read from its log. Costs no Copilot process. */
export async function sessionModel(sessionId: string): Promise<SessionModel | null> {
  const { current } = await request('sessions.model', { sessionId });
  return current;
}

/** How full a loaded session's window is. Null when it is not loaded, which is not changed by asking. */
export async function sessionContext(sessionId: string): Promise<SessionContextUsage | null> {
  const { usage } = await request('sessions.context', { sessionId });
  return usage;
}

/**
 * What a session has spent. Costs no Copilot process, loaded or not.
 *
 * A loaded session accounts for tokens and the code it changed as well; a cold one is read
 * from its log and can only give the two running totals.
 */
export async function sessionUsage(sessionId: string): Promise<SessionUsage | null> {
  const { usage } = await request('sessions.usage', { sessionId });
  return usage;
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

/** How a session is working, read from its log when it is cold. Costs no Copilot process. */
export async function sessionMode(sessionId: string): Promise<SessionMode> {
  const { mode } = await request('sessions.mode', { sessionId });
  return mode;
}

/** Put a session into a mode, answering with the one that took. Resumes it if it is cold. */
export function setSessionMode(
  sessionId: string,
  mode: SessionMode,
): Promise<{ mode: SessionMode; notice?: string }> {
  return request('sessions.setMode', { sessionId, mode });
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

/**
 * Turn an MCP server on or off for sessions started from now on.
 *
 * Costs no Copilot process. A session already running keeps the servers it connected to.
 */
export function setMcpEnabled(name: string, enabled: boolean): Promise<void> {
  return request('mcp.setEnabled', { name, enabled });
}

/**
 * Write a server into the reader's own config, or change one already there.
 *
 * Costs no Copilot process: the config is a file rather than anything a conversation holds.
 * Sessions already running keep the servers they connected to.
 */
export function saveMcpServer(name: string, config: McpServerConfig): Promise<void> {
  return request('mcp.save', { name, config });
}

/** Take a server out of the reader's own config. Costs no Copilot process. */
export function removeMcpServer(name: string): Promise<void> {
  return request('mcp.remove', { name });
}

/**
 * What each MCP server is actually doing in a session.
 *
 * Null for a session that is not loaded, which is not a failure: only a session that has
 * tried to connect can say whether it worked, and this never resumes one to ask.
 */
export async function mcpStatus(sessionId: string): Promise<McpServerState[] | null> {
  const { servers } = await request('mcp.status', { sessionId });
  return servers;
}

/**
 * Begin signing in to a server that is waiting for it.
 *
 * Answers with the page to send the reader to. Unlike reading the status, this may resume
 * the session: signing in is something they asked for by pressing a button.
 */
export async function mcpLogin(sessionId: string, name: string): Promise<string | null> {
  const { authorizationUrl } = await request('mcp.login', { sessionId, name });
  return authorizationUrl;
}

/** The MCP servers there are, for completing a command that wants one. Costs no Copilot process. */
export async function listMcpServers(cwd?: string): Promise<McpServerSummary[]> {
  const { servers } = await request('mcp.servers', { cwd });
  return servers;
}

/** Every page in the local knowledge base. A disk read, so it costs no Copilot process. */
export function listWikiPages(): Promise<{ pages: WikiPage[]; root: string; exists: boolean }> {
  return request('wiki.pages');
}

/** One page by its path relative to the wiki root. Null for a path outside it, or a page that has gone. */
export async function readWikiPage(path: string): Promise<WikiPageContent | null> {
  const { page } = await request('wiki.page', { path });
  return page;
}

/** Write a page back as it was edited. False when it could not be written. */
export async function saveWikiPage(path: string, source: string): Promise<boolean> {
  const { saved } = await request('wiki.save', { path, source });
  return saved;
}

/** Start a knowledge base where one was expected, answering with the page to open. */
export async function createWiki(): Promise<string | null> {
  const { page } = await request('wiki.create');
  return page;
}

/** The pages answering a query, best first. A disk read, so it costs no Copilot process. */
export async function searchWiki(query: string, limit?: number): Promise<WikiSearchResult[]> {
  const { results } = await request('wiki.search', { query, limit });
  return results;
}

/** The notes a session's subject already has, where there are any for certain (#35). */
export function wikiForSession(
  repository: string | null,
  cwd: string | null,
  tags: string[],
): Promise<{ name: string | null; pages: WikiPage[] }> {
  return request('wiki.forSession', { repository, cwd, tags });
}

/** Every tag the wiki already uses, commonest first, for the picker to offer (#35). */
export async function wikiTags(): Promise<{ tag: string; pages: number }[]> {
  const { tags } = await request('wiki.tags');
  return tags;
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

/** The whole state of a working tree, for the source control panel. Null outside a repository. */
export async function gitStatus(cwd: string): Promise<RepoStatus | null> {
  const { status } = await request('git.status', { cwd });
  return status;
}

/** One file's diff, on the side the row belongs to: the index against HEAD, or the tree against the index. */
export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<FileDiff> {
  const { diff } = await request('git.diff', { cwd, path, staged });
  return diff;
}

/**
 * Put one path into the index, or take it back out, and get the tree as it stands after.
 *
 * Unstaging never touches the working tree: the sidecar writes the index directly rather
 * than through a command that is also capable of overwriting files.
 */
export async function gitStage(cwd: string, paths: string[], staged: boolean): Promise<RepoStatus | null> {
  const { status } = await request('git.stage', { cwd, paths, staged });
  return status;
}

/**
 * Send the current branch to its remote, or bring the remote's work down onto it.
 *
 * There is no force anywhere behind this. A pull is fast-forward only until somebody says
 * how two branches that have both moved on should be reconciled, and answers `diverged`
 * rather than choosing for them (#205).
 */
export async function gitSync(
  cwd: string,
  direction: 'push' | 'pull',
  strategy?: MergeStrategy,
): Promise<{ status: RepoStatus | null; diverged: boolean }> {
  const { status, diverged } = await request('git.sync', { cwd, direction, ...(strategy ? { strategy } : {}) });
  return { status, diverged: diverged === true };
}

/** The local branches, and which one is checked out. */
export async function gitBranches(cwd: string): Promise<{ name: string; current: boolean }[]> {
  const { branches } = await request('git.branches', { cwd });
  return branches;
}

/**
 * Check out a branch, or make one and check it out.
 *
 * Uncommitted work comes along, because git carries it across when it can and refuses when
 * a file would be overwritten.
 */
export async function gitSwitch(cwd: string, name: string, create: boolean): Promise<RepoStatus | null> {
  const { status } = await request('git.switch', { cwd, name, create });
  return status;
}

/**
 * Commit what is staged, or amend the commit at HEAD, and get the tree as it stands after.
 *
 * The message is the reader's own. Repository hooks and signing configuration apply, because
 * the sidecar runs git as they would.
 */
export async function gitCommit(cwd: string, message: string, amend: boolean): Promise<RepoStatus | null> {
  const { status } = await request('git.commit', { cwd, message, amend });
  return status;
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
 * Replays one subagent's own transcript from its session's log (#178).
 *
 * Read rather than remembered, so a delegating session is not holding every agent's work
 * for as long as it is open.
 */
export function getAgentTranscript(sessionId: string, agentId: string): Promise<{ events: TranscriptEvent[] }> {
  return request('sessions.agentTranscript', { sessionId, agentId });
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

/** Let a session work in a directory without being asked about it each time (#210). */
export function allowSessionFolder(sessionId: string, path: string): Promise<{ allowed: boolean }> {
  return request('sessions.allowFolder', { sessionId, path });
}

/**
 * The turns a session could be put back to (#156).
 *
 * Costs a resume, unlike the change list beside it: the runtime answers this from the live
 * session rather than from the snapshots on disk.
 */
export function getRewindPoints(
  sessionId: string,
): Promise<{ points: RewindPoint[]; unavailable?: RewindUnavailable }> {
  return request('sessions.rewindPoints', { sessionId });
}

/** What going back to that turn would put back, asked before anything is done. */
export function previewRewind(sessionId: string, eventId: string): Promise<RewindPreview> {
  return request('sessions.previewRewind', { sessionId, eventId });
}

/** Put the session back. The conversation goes either way; `files` chooses about the rest. */
export function rewindSession(sessionId: string, eventId: string, files: boolean): Promise<RewindResult> {
  return request('sessions.rewind', { sessionId, eventId, files });
}

/** The diff for one of those files, over the same span the list was built with. */
export function getDiff(sessionId: string, path: string, since?: string): Promise<FileDiff> {
  return request('sessions.diff', { sessionId, path, since });}

/** Starts a session in a directory. Costs a Copilot process, like sending does. */
export function createSession(defaults: {
  workingDirectory?: string;
  allowAll?: boolean;
  model?: string;
} = {}): Promise<{ sessionId: string }> {
  return request('sessions.create', defaults);
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

/**
 * Sort dropped paths into what can be attached and what cannot (#231).
 *
 * The webview hands over paths and nothing else, and this window cannot read the disk to
 * tell a file from a folder - that is the sidecar's job, for the same reason a preview
 * comes from there rather than over `file://`.
 */
export function classifyDropped(paths: string[]): Promise<Dropped> {
  return request('attachments.dropped', { paths });
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

/** The agent has a plan and is blocked until the reader approves or turns it down. */
export function onPlanRequested(handler: (payload: PendingPlanApproval) => void) {
  return listen<PendingPlanApproval>('plan-requested', (e) => handler(e.payload));
}

export function onPlanResolved(handler: (payload: PlanResolvedNotification) => void) {
  return listen<PlanResolvedNotification>('plan-resolved', (e) => handler(e.payload));
}

/** Approve a plan and say how to proceed, or turn it down with a reason. */
export function resolvePlan(
  requestId: string,
  approved: boolean,
  selectedAction?: PlanAction,
  feedback?: string,
): Promise<void> {
  return request('sessions.resolvePlan', { requestId, approved, selectedAction, feedback });
}
