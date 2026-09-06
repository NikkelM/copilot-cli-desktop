/**
 * Node sidecar: owns all Copilot CLI interaction and speaks newline-delimited
 * JSON-RPC over stdio to the Tauri shell.
 *
 * It lives in Node rather than Rust because @github/copilot-sdk is TypeScript and
 * ships bundled with the CLI, which keeps the SDK and CLI versions in lockstep.
 */
import { createInterface } from 'node:readline';

import type {
  ElicitationAction,
  ElicitationFieldValue,
  JsonRpcRequest,
  SnapshotScope,
  JsonRpcResponse,
  PermissionChoice,
} from '../../shared/protocol.js';
import {
  NOTIFY_ELICITATION_REQUESTED,
  NOTIFY_ELICITATION_RESOLVED,
  NOTIFY_PERMISSION_REQUESTED,
  NOTIFY_PERMISSION_RESOLVED,
  NOTIFY_SESSION_EVENT,
  NOTIFY_SESSION_LOADED,
  NOTIFY_SESSIONS_CHANGED,
} from '../../shared/protocol.js';
import { type Channel, startDevChannel } from './devChannel.js';
import { readTranscript } from './eventLog.js';
import { type ApprovalPolicy, SessionRuntime } from './runtime.js';
import { listSessions } from './sessionIndex.js';
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
      const sessions = listSessions().map((session) => ({
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

    case 'sessions.send': {
      const { sessionId, prompt, mode } = request.params as {
        sessionId: string;
        prompt: string;
        mode?: 'enqueue' | 'immediate';
      };
      return { messageId: await runtime.send(sessionId, prompt, mode) };
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

    case 'sessions.setApprovalPolicy': {
      const { sessionId, policy } = request.params as {
        sessionId: string;
        policy: ApprovalPolicy;
      };
      runtime.setApprovalPolicy(sessionId, policy);
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

    case 'sessions.changes': {
      const { sessionId, scope } = request.params as { sessionId: string; scope?: SnapshotScope };
      const found = await runtime.changes(sessionId, scope);
      return found ?? { root: null, changes: [], points: [] };
    }

    case 'sessions.diff': {
      const { sessionId, path, scope } = request.params as { sessionId: string; path: string; scope?: SnapshotScope };
      return { patch: (await runtime.diff(sessionId, path, scope)) ?? '' };
    }

    case 'sessions.rewind': {
      const { sessionId, scope } = request.params as { sessionId: string; scope?: SnapshotScope };
      const undone = await runtime.rewind(sessionId, scope);
      return undone ?? { root: null, changes: [], points: [] };
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
