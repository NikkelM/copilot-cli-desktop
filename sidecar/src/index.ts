/**
 * Node sidecar: owns all Copilot CLI interaction and speaks newline-delimited
 * JSON-RPC over stdio to the Tauri shell.
 *
 * It lives in Node rather than Rust because @github/copilot-sdk is TypeScript and
 * ships bundled with the CLI, which keeps the SDK and CLI versions in lockstep.
 */
import { createInterface } from 'node:readline';

import type { JsonRpcRequest, JsonRpcResponse } from '../../shared/protocol.js';
import {
  NOTIFY_ELICITATION_REQUESTED,
  NOTIFY_ELICITATION_RESOLVED,
  NOTIFY_PLAN_REQUESTED,
  NOTIFY_PLAN_RESOLVED,
  NOTIFY_PERMISSION_REQUESTED,
  NOTIFY_PERMISSION_RESOLVED,
  NOTIFY_SESSION_EVENT,
  NOTIFY_SESSION_CHANGES,
  NOTIFY_SESSION_LOADED,
  NOTIFY_SESSIONS_CHANGED,
} from '../../shared/protocol.js';
import type { Channel } from './devChannel.js';
import { createHandlers, dispatch } from './dispatch.js';
import { SessionRuntime } from './runtime.js';
import { watchSessionStore } from './storeWatcher.js';

/** Anything written to stdout is protocol, so diagnostics must go to stderr. */
function log(message: string): void {
  process.stderr.write(`[sidecar] ${message}\n`);
}

/** The Tauri shell, which owns this process and reads its stdout. */
const stdio: Channel = {
  write: (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`),
};

/**
 * The dev channel, if this build has one.
 *
 * Loaded on demand, and only when the variable that turns it on is set, so that a packaged
 * copy can leave the module out altogether - which `scripts/bundle-sidecar.mjs` does. A
 * released app therefore contains no code that could open a socket, rather than code that
 * declines to: the difference matters because the guard is an environment variable, and
 * anything able to set one on this process would otherwise get an unauthenticated way to
 * send prompts to any session.
 *
 * Until it resolves - and forever, in a build without it - broadcasting does nothing, which
 * is what it does when the channel is off anyway.
 */
let broadcast: (payload: unknown) => void = () => undefined;

if (process.env.COPILOT_DESKTOP_DEV_PORT) {
  void import('./devChannel.js')
    .then(({ startDevChannel }) => {
      broadcast = startDevChannel({ onRequest: (raw, channel) => handle(raw, channel), log }).broadcast;
    })
    .catch(() => log('COPILOT_DESKTOP_DEV_PORT is set, but this build has no dev channel'));
}

/**
 * Notifications go to the shell and to any dev client, so a prompt sent over the dev
 * channel drives the real UI rather than a parallel copy of it.
 */
function notify(method: string, params: unknown): void {
  const payload = { jsonrpc: '2.0', method, params };
  stdio.write(payload);
  broadcast(payload);
}

const runtime = new SessionRuntime({
  onEvent: (sessionId, event) => notify(NOTIFY_SESSION_EVENT, { sessionId, event }),
  onLoadedChange: (sessionId, loaded, loading) => notify(NOTIFY_SESSION_LOADED, { sessionId, loaded, loading }),
  onChangesRecorded: (sessionId) => notify(NOTIFY_SESSION_CHANGES, { sessionId }),
  onPermissionRequest: (sessionId, requestId, request, expiresAt, offerFolder) =>
    notify(NOTIFY_PERMISSION_REQUESTED, {
      sessionId,
      requestId,
      request,
      expiresAt,
      ...(offerFolder ? { offerFolder } : {}),
    }),
  onPermissionResolved: (sessionId, requestId) =>
    notify(NOTIFY_PERMISSION_RESOLVED, { sessionId, requestId }),
  onElicitationRequest: (sessionId, requestId, context, expiresAt) =>
    notify(NOTIFY_ELICITATION_REQUESTED, { sessionId, requestId, ...context, expiresAt }),
  onElicitationResolved: (requestId) => notify(NOTIFY_ELICITATION_RESOLVED, { requestId }),
  onPlanRequest: (sessionId, requestId, plan, expiresAt) =>
    notify(NOTIFY_PLAN_REQUESTED, { sessionId, requestId, ...plan, expiresAt }),
  onPlanResolved: (requestId) => notify(NOTIFY_PLAN_RESOLVED, { requestId }),
});

const handlers = createHandlers(runtime);

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

  const task = dispatch(handlers, request)
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
