/**
 * The methods the sidecar answers, and the lookup that routes to them.
 *
 * Separate from `index.ts` because that module starts a runtime, a store watcher and a
 * reader on stdin the moment it is imported, which leaves the request surface of the whole
 * app impossible to exercise except by running it.
 */
import type { JsonRpcRequest, SidecarHandlers } from '../../shared/protocol.js';
import { PROTOCOL_VERSION } from '../../shared/protocol.js';
import { sessionChanges, sessionDiff } from './changes.js';
import { directoryCaseSensitive, directorySeparator, listDirectories } from './directories.js';
import { lastAgent, lastModel, locateTurn, readAgentTranscript, readTranscript } from './eventLog.js';
import { updateCli } from './updateCli.js';
import {
  commitStaged,
  diffOf,
  listBranches,
  pullBranch,
  pushBranch,
  stagePaths,
  statusOf,
  switchBranch,
  treeStateOf,
  unstagePaths,
} from './git.js';
import { previewImage } from './images.js';
import { cliSettingsSchema, readCliSettings, writeCliSettings } from './cliSettings.js';
import { purgeSession } from './recycleBin.js';
import { sessionDiskUsage } from './diskUsage.js';
import { momentAfter, searchSessions } from './sessionSearch.js';
import { stashPaste } from './pastes.js';
import type { SessionRuntime } from './runtime.js';
import { existingSessions, findSessions, listSessions, renameSession } from './sessionIndex.js';
import {
  createWiki,
  listWikiPages,
  readWikiPage,
  searchWikiPages,
  wikiDir,
  wikiExists,
  writeWikiPage,
} from './wiki.js';

export function createHandlers(runtime: SessionRuntime): SidecarHandlers {
  return {
    /**
     * Answered from the build this process came from, not from the request.
     *
     * Deliberately the cheapest handler there is, and one that touches no runtime state:
     * it has to work on a sidecar that is otherwise too old to be useful, because saying
     * so is its entire job.
     */
    'protocol.version': () => ({ version: PROTOCOL_VERSION }),

    'sessions.list': () => {
      // The sessions the runtime holds are listed even when the database would hide them:
      // one just started has no title and no turns yet.
      const sessions = listSessions(runtime.status().activeSessionIds).map((session) => ({
        ...session,
        loaded: runtime.isActive(session.sessionId),
      }));
      return { sessions };
    },

    'sessions.find': ({ prefix }) => {
      const sessions = findSessions(prefix).map((session) => ({
        ...session,
        loaded: runtime.isActive(session.sessionId),
      }));
      return { sessions };
    },

    'sessions.exist': ({ sessionIds }) => ({ sessionIds: existingSessions(sessionIds) }),

    'sessions.transcript': ({ sessionId, limit, before }) => readTranscript(sessionId, limit, before),

    'sessions.agentTranscript': async ({ sessionId, agentId }) => ({
      events: await readAgentTranscript(sessionId, agentId),
    }),

    'sessions.changes': async ({ sessionId, since }) => {
      await runtime.flushChanges(sessionId);
      return { changes: sessionChanges(sessionId, since) };
    },

    'sessions.diff': async ({ sessionId, path, since }) => {
      await runtime.flushChanges(sessionId);
      return sessionDiff(sessionId, path, since);
    },

    'sessions.rewindPoints': ({ sessionId }) => runtime.rewindPoints(sessionId),

    'sessions.previewRewind': ({ sessionId, eventId }) => runtime.previewRewind(sessionId, eventId),

    'sessions.rewind': ({ sessionId, eventId, files }) => runtime.rewind(sessionId, eventId, files),

    'sessions.send': ({ sessionId, prompt, mode, attachments }) =>
      runtime.send(sessionId, prompt, mode, attachments),

    'sessions.abort': ({ sessionId }) => runtime.abort(sessionId),

    'sessions.shell': ({ sessionId, requestId, command }) => runtime.shell(sessionId, requestId, command),

    'sessions.cancelShell': ({ sessionId, requestId }) => runtime.cancelShell(sessionId, requestId),

    // Not the runtime's: a name lives in a file, so a session nobody has opened can be
    // renamed without waking anything.
    'sessions.rename': ({ sessionId, name }) => renameSession(sessionId, name),

    'runtime.update': () => updateCli(),

    'runtime.limits': ({ maxLoadedSessions, idleTimeoutMs, binRetentionDays, permissionTimeoutMs, allowAll }) =>
      runtime.setLimits({ maxLoadedSessions, idleTimeoutMs, binRetentionDays, permissionTimeoutMs, allowAll }),

    'sessions.load': ({ sessionId }) => runtime.load(sessionId),

    'sessions.evict': ({ sessionId }) => runtime.evict(sessionId),

    'sessions.delete': ({ sessionId }) => runtime.deleteSession(sessionId),

    'sessions.fork': async ({ sessionId, name }) => ({
      sessionId: await runtime.forkSession(sessionId, name),
    }),

    'bin.list': () => runtime.binnedSessions(),

    'bin.restore': ({ sessionId }) => ({ restored: runtime.restoreSession(sessionId) }),

    'bin.purge': ({ sessionId }) => purgeSession(sessionId),

    'sessions.disk': async () => ({ sessions: await sessionDiskUsage() }),

    'sessions.search': ({ query }) => ({ matches: searchSessions(query) }),

    /**
     * Where to open a session so a match is on the page, as a cursor to read back from.
     * Null when the log does not reach that far, which a truncated one will not.
     */
    'sessions.locate': async ({ sessionId, source, at }) => {
      // A caller with a moment in hand is answered from it. Otherwise the handle names a
      // turn the database knows the time of.
      const until = at ?? (source === undefined ? undefined : momentAfter(sessionId, source));
      // Undefined names nothing the database holds, which is not the same as a match that
      // runs to the end of the log.
      return { cursor: until === undefined ? null : await locateTurn(sessionId, until) };
    },

    'cliSettings.list': () => ({ settings: cliSettingsSchema(), values: readCliSettings() }),

    'cliSettings.values': () => readCliSettings(),

    // Null on the wire rather than undefined, since JSON has no undefined to send: a key
    // the reader cleared arrives as null and is taken out of the CLI's file.
    'cliSettings.write': ({ changes }) =>
      writeCliSettings(
        Object.fromEntries(Object.entries(changes).map(([path, value]) => [path, value ?? undefined])),
      ),

    'sessions.resolvePermission': ({ requestId, choice }) => runtime.resolvePermission(requestId, choice),

    'sessions.allowFolder': ({ sessionId, path }) => runtime.allowFolder(sessionId, path),

    'sessions.resolveElicitation': ({ requestId, action, content }) =>
      runtime.resolveElicitation(requestId, action, content),
    'sessions.resolvePlan': ({ requestId, approved, selectedAction, feedback }) =>
      runtime.resolvePlan(requestId, approved, selectedAction, feedback),

    'sessions.create': ({ workingDirectory, allowAll, model, reasoningEffort, contextTier }) =>
      runtime.create(workingDirectory, { allowAll, model, reasoningEffort, contextTier }),

    'attachments.stash': (params) => ({ path: stashPaste(params) }),

    'attachments.preview': ({ path }) => ({ dataUrl: previewImage(path) }),

    'models.list': async () => ({ models: await runtime.discovery.models() }),

    // Params are read defensively because a caller with nothing to say may send none at all,
    // and the one field here is optional in the first place.
    'commands.list': async (params) => ({ commands: await runtime.commands(params?.sessionId) }),

    'filesystem.directories': async ({ cwd, path }) => ({
      entries: await listDirectories(cwd, path),
      separator: directorySeparator,
      caseSensitive: directoryCaseSensitive,
    }),

    'wiki.pages': async () => ({
      pages: await listWikiPages(),
      root: wikiDir,
      exists: await wikiExists(),
    }),

    'wiki.page': async ({ path }) => ({ page: await readWikiPage(path) }),

    'wiki.save': async ({ path, source }) => ({ saved: await writeWikiPage(path, source) }),

    'wiki.create': async () => ({ page: await createWiki() }),

    'wiki.search': async ({ query, limit }) => ({
      results: await searchWikiPages(query, limit ?? 25),
    }),

    'commands.invoke': async ({ sessionId, name, input }) => ({
      outcome: await runtime.invoke(sessionId, name, input),
    }),

    'commands.enqueue': async ({ sessionId, command, displayText }) => ({
      queued: await runtime.enqueue(sessionId, command, displayText),
    }),

    'sessions.queue': async ({ sessionId }) => ({ items: await runtime.queue(sessionId) }),

    // Params are read defensively for the same reason `commands.list` reads them that way:
    // a caller browsing agents outside any session has nothing to say and may send nothing.
    'agents.list': async (params) => ({ agents: await runtime.discovery.agents(params?.cwd) }),

    'agents.current': async ({ sessionId }) => ({ agent: await lastAgent(sessionId) }),

    'agents.select': ({ sessionId, name }) => runtime.selectAgent(sessionId, name),

    'agents.deselect': ({ sessionId }) => runtime.selectAgent(sessionId, null),

    'environment.describe': (params) => runtime.discovery.environment(params?.cwd),

    'mcp.setEnabled': ({ name, enabled }) => runtime.discovery.setMcpEnabled(name, enabled),

    // Params are read defensively: a composer completing a command outside any session has
    // no directory to name.
    'mcp.servers': async (params) => ({ servers: await runtime.discovery.mcpServers(params?.cwd) }),

    'mcp.save': ({ name, config }) => runtime.discovery.saveMcpServer(name, config),

    'mcp.remove': ({ name }) => runtime.discovery.removeMcpServer(name),

    'mcp.status': async ({ sessionId }) => ({ servers: await runtime.mcpStatus(sessionId) }),

    'mcp.login': async ({ sessionId, name }) => ({ authorizationUrl: await runtime.mcpLogin(sessionId, name) }),

    'skills.disabled': ({ sessionId }) => ({ disabled: runtime.disabledSkills(sessionId) }),

    'skills.set': async ({ sessionId, name, enabled }) => ({
      disabled: await runtime.setSkillEnabled(sessionId, name, enabled),
    }),

    'sessions.model': async ({ sessionId }) => ({ current: await lastModel(sessionId) }),

    'sessions.context': async ({ sessionId }) => ({ usage: await runtime.contextUsage(sessionId) }),

    'sessions.usage': async ({ sessionId }) => ({ usage: await runtime.usage(sessionId) }),

    'sessions.setModel': ({ sessionId, model, reasoningEffort, contextTier }) =>
      runtime.setModel(sessionId, model, reasoningEffort, contextTier),
    'sessions.mode': async ({ sessionId }) => ({ mode: await runtime.mode(sessionId) }),
    'sessions.setMode': ({ sessionId, mode }) => runtime.setMode(sessionId, mode),

    'git.state': async ({ cwd }) => ({ state: await treeStateOf(cwd) }),

    'git.status': async ({ cwd }) => ({ status: await statusOf(cwd) }),

    'git.diff': async ({ cwd, path, staged }) => ({ diff: await diffOf(cwd, path, staged) }),

    /**
     * The tree is read again here rather than by the caller, so the panel can never draw a
     * state that was assumed: what it shows afterwards is what git says, not what the app
     * expected the operation to do.
     */
    'git.stage': async ({ cwd, paths, staged }) => {
      if (staged) await stagePaths(cwd, paths);
      else await unstagePaths(cwd, paths);
      return { status: await statusOf(cwd) };
    },

    'git.commit': async ({ cwd, message, amend }) => {
      await commitStaged(cwd, message, amend);
      return { status: await statusOf(cwd) };
    },

    'git.sync': async ({ cwd, direction, strategy }) => {
      if (direction === 'push') {
        await pushBranch(cwd);
        return { status: await statusOf(cwd) };
      }

      const { diverged } = await pullBranch(cwd, strategy);
      // The tree is read either way: a pull that stopped to ask changed nothing, and the
      // panel showing what git says beats it showing what this assumed would happen.
      return { status: await statusOf(cwd), diverged };
    },

    'git.branches': async ({ cwd }) => ({ branches: await listBranches(cwd) }),

    'git.switch': async ({ cwd, name, create }) => {
      await switchBranch(cwd, name, create);
      return { status: await statusOf(cwd) };
    },

    'runtime.status': () => runtime.status(),
  };
}

/** Route one request to its handler. Errors are the caller's to turn into a reply. */
export async function dispatch(handlers: SidecarHandlers, request: JsonRpcRequest): Promise<unknown> {
  // Own properties only: the method arrives as text, and a plain lookup would answer
  // "constructor" or "toString" with something inherited and then call it.
  const handler = Object.hasOwn(handlers, request.method)
    ? (handlers[request.method] as (params: unknown) => unknown)
    : undefined;
  if (!handler) throw new Error(`Unknown method: ${request.method}`);

  // A handler that answers with nothing still owes the caller a reply, and a missing
  // `result` is not the same thing as an empty one once it has been through JSON.
  return (await handler(request.params)) ?? null;
}

