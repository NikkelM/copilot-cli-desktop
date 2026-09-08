/**
 * Node sidecar: owns all Copilot CLI interaction and speaks newline-delimited
 * JSON-RPC over stdio to the Tauri shell.
 *
 * It lives in Node rather than Rust because @github/copilot-sdk is TypeScript and
 * ships bundled with the CLI, which keeps the SDK and CLI versions in lockstep.
 */
import { createInterface } from 'node:readline';

import type {
  Attachment,
  ContextTier,
  ElicitationAction,
  ElicitationFieldValue,
  JsonRpcRequest,
  JsonRpcResponse,
  PermissionChoice,
  ReasoningEffort,
} from '../../shared/protocol.js';
import {
  NOTIFY_ELICITATION_REQUESTED,
  NOTIFY_ELICITATION_RESOLVED,
  NOTIFY_PERMISSION_REQUESTED,
  NOTIFY_PERMISSION_RESOLVED,
  NOTIFY_SESSION_EVENT,
  NOTIFY_SESSION_CHANGES,
  NOTIFY_SESSION_LOADED,
  NOTIFY_SESSIONS_CHANGED,
} from '../../shared/protocol.js';
import { type Channel, startDevChannel } from './devChannel.js';
import { sessionChanges, sessionDiff } from './changes.js';
import { lastModel, readTranscript } from './eventLog.js';
import { treeStateOf } from './git.js';
import { SessionRuntime } from './runtime.js';
import { findSessions, listSessions } from './sessionIndex.js';
import { watchSessionStore } from './storeWatcher.js';

/** Anything written to stdout is protocol, so diagnostics must go to stderr. */
function log(message: string): void {
  process.stderr.write(`[sidecar] ${message}\n`);
}

/** The Tauri shell, which owns this process and reads its stdout. */
const stdio: Channel = {
  write: (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`),
};

const dev = startDevChannel({ onRequest: (raw, channel) => handle(raw, channel), log });

/**
 * Notifications go to the shell and to any dev client, so a prompt sent over the dev
 * channel drives the real UI rather than a parallel copy of it.
 */
function notify(method: string, params: unknown): void {
  const payload = { jsonrpc: '2.0', method, params };
  stdio.write(payload);
  dev.broadcast(payload);
}

const runtime = new SessionRuntime({
  onEvent: (sessionId, event) => notify(NOTIFY_SESSION_EVENT, { sessionId, event }),
  onLoadedChange: (sessionId, loaded) => notify(NOTIFY_SESSION_LOADED, { sessionId, loaded }),
  onChangesRecorded: (sessionId) => notify(NOTIFY_SESSION_CHANGES, { sessionId }),
  onPermissionRequest: (sessionId, requestId, request) =>
    notify(NOTIFY_PERMISSION_REQUESTED, { sessionId, requestId, request }),
  onPermissionResolved: (sessionId, requestId) =>
    notify(NOTIFY_PERMISSION_RESOLVED, { sessionId, requestId }),
  onElicitationRequest: (sessionId, requestId, context) =>
    notify(NOTIFY_ELICITATION_REQUESTED, { sessionId, requestId, ...context }),
  onElicitationResolved: (requestId) => notify(NOTIFY_ELICITATION_RESOLVED, { requestId }),
});

async function dispatch(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'sessions.list': {
      // The sessions the runtime holds are listed even when the database would hide them:
      // one just started has no title and no turns yet.
      const sessions = listSessions(runtime.status().activeSessionIds).map((session) => ({
        ...session,
        loaded: runtime.isActive(session.sessionId),
      }));
      return { sessions };
    }

    case 'sessions.find': {
      const { prefix } = request.params as { prefix: string };
      const sessions = findSessions(prefix).map((session) => ({
        ...session,
        loaded: runtime.isActive(session.sessionId),
      }));
      return { sessions };
    }

    case 'sessions.transcript': {
      const { sessionId, limit, before } = request.params as {
        sessionId: string;
        limit?: number;
        before?: number;
      };
      return readTranscript(sessionId, limit, before);
    }

    case 'sessions.changes': {
      const { sessionId, since } = request.params as { sessionId: string; since?: string };
      await runtime.flushChanges(sessionId);
      return { changes: sessionChanges(sessionId, since) };
    }

    case 'sessions.diff': {
      const { sessionId, path, since } = request.params as { sessionId: string; path: string; since?: string };
      await runtime.flushChanges(sessionId);
      return sessionDiff(sessionId, path, since);
    }

    case 'sessions.send': {
      const { sessionId, prompt, mode, attachments } = request.params as {
        sessionId: string;
        prompt: string;
        mode?: 'enqueue' | 'immediate';
        attachments?: Attachment[];
      };
      return runtime.send(sessionId, prompt, mode, attachments);
    }

    case 'sessions.abort': {
      const { sessionId } = request.params as { sessionId: string };
      await runtime.abort(sessionId);
      return null;
    }

    case 'sessions.evict': {
      const { sessionId } = request.params as { sessionId: string };
      await runtime.evict(sessionId);
      return null;
    }

    case 'sessions.resolvePermission': {
      const { requestId, choice } = request.params as {
        requestId: string;
        choice: PermissionChoice;
      };
      runtime.resolvePermission(requestId, choice);
      return null;
    }

    case 'sessions.resolveElicitation': {
      const { requestId, action, content } = request.params as {
        requestId: string;
        action: ElicitationAction;
        content?: Record<string, ElicitationFieldValue>;
      };
      runtime.resolveElicitation(requestId, action, content);
      return null;
    }

    case 'sessions.create': {
      const { workingDirectory } = request.params as { workingDirectory: string };
      return runtime.create(workingDirectory);
    }

    case 'models.list':
      return { models: await runtime.models() };

    case 'commands.list': {
      const { sessionId } = (request.params ?? {}) as { sessionId?: string };
      return { commands: await runtime.commands(sessionId) };
    }

    case 'commands.invoke': {
      const { sessionId, name, input } = request.params as {
        sessionId: string;
        name: string;
        input?: string;
      };
      return { outcome: await runtime.invoke(sessionId, name, input) };
    }

    case 'sessions.model': {
      const { sessionId } = request.params as { sessionId: string };
      return { current: await lastModel(sessionId) };
    }

    case 'sessions.setModel': {
      const { sessionId, model, reasoningEffort, contextTier } = request.params as {
        sessionId: string;
        model: string;
        reasoningEffort?: ReasoningEffort;
        contextTier?: ContextTier;
      };
      await runtime.setModel(sessionId, model, reasoningEffort, contextTier);
      return null;
    }

    case 'git.state': {
      const { cwd } = request.params as { cwd: string };
      return { state: await treeStateOf(cwd) };
    }

    case 'runtime.status':
      return runtime.status();

    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}

/** Requests still running, so shutdown can wait for them to settle. */
const inFlight = new Set<Promise<void>>();

/**
 * Parse and execute one request line, replying on the channel it arrived from.
 * Shared by stdio and the dev channel so both behave identically.
 */
function handle(line: string, channel: Channel): void {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    log(`dropped malformed request: ${line.slice(0, 120)}`);
    return;
  }

  const reply = (response: JsonRpcResponse) => channel.write(response);

  const task = dispatch(request)
    .then((result) => reply({ jsonrpc: '2.0', id: request.id, result }))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`${request.method} failed: ${message}`);
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message } });
    })
    .finally(() => inFlight.delete(task));

  inFlight.add(task);
}

function main(): void {
  const { cliPath } = SessionRuntime.probeInstallation();
  log(cliPath ? `CLI: ${cliPath}` : 'CLI not found - set COPILOT_CLI_PATH');

  // Keeps the sidebar current for sessions running anywhere, including terminals this
  // app knows nothing about, without waking on a timer.
  const watcher = watchSessionStore(() => notify(NOTIFY_SESSIONS_CHANGED, null));
  log(watcher ? 'watching session store for changes' : 'session store watch unavailable');

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed) handle(trimmed, stdio);
  });

  // Drain outstanding work and release the CLI server before exiting, so a request
  // issued just before stdin closes still gets a response.
  rl.on('close', () => {
    watcher?.close();
    void Promise.allSettled([...inFlight])
      .then(() => runtime.shutdown())
      .catch(() => undefined)
      .then(() => process.exit(0));
  });

  log('ready');
}

main();
