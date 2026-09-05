/**
 * Node sidecar: owns all Copilot CLI interaction and speaks newline-delimited
 * JSON-RPC over stdio to the Tauri shell.
 *
 * It lives in Node rather than Rust because @github/copilot-sdk is TypeScript and
 * ships bundled with the CLI, which keeps the SDK and CLI versions in lockstep.
 */
import { createInterface } from 'node:readline';

import type { JsonRpcRequest, JsonRpcResponse } from '../../shared/protocol.js';
import { NOTIFY_SESSION_EVENT, NOTIFY_SESSION_LOADED } from '../../shared/protocol.js';
import { readTranscript } from './eventLog.js';
import { type ApprovalPolicy, SessionRuntime } from './runtime.js';
import { listSessions } from './sessionIndex.js';

/** Anything written to stdout is protocol, so diagnostics must go to stderr. */
function log(message: string): void {
  process.stderr.write(`[sidecar] ${message}\n`);
}

function write(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(response: JsonRpcResponse): void {
  write(response);
}

function notify(method: string, params: unknown): void {
  write({ jsonrpc: '2.0', method, params });
}

const runtime = new SessionRuntime({
  onEvent: (sessionId, event) => notify(NOTIFY_SESSION_EVENT, { sessionId, event }),
  onLoadedChange: (sessionId, loaded) => notify(NOTIFY_SESSION_LOADED, { sessionId, loaded }),
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
      const { sessionId, limit } = request.params as { sessionId: string; limit?: number };
      return readTranscript(sessionId, limit);
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

    case 'runtime.status':
      return runtime.status();

    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}

function main(): void {
  const { cliPath } = SessionRuntime.probeInstallation();
  log(cliPath ? `CLI: ${cliPath}` : 'CLI not found - set COPILOT_CLI_PATH');

  const rl = createInterface({ input: process.stdin });
  const inFlight = new Set<Promise<void>>();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      log(`dropped malformed request: ${trimmed.slice(0, 120)}`);
      return;
    }

    const task = dispatch(request)
      .then((result) => reply({ jsonrpc: '2.0', id: request.id, result }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`${request.method} failed: ${message}`);
        reply({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message } });
      })
      .finally(() => inFlight.delete(task));

    inFlight.add(task);
  });

  // Drain outstanding work and release the CLI server before exiting, so a request
  // issued just before stdin closes still gets a response.
  rl.on('close', () => {
    void Promise.allSettled([...inFlight])
      .then(() => runtime.shutdown())
      .catch(() => undefined)
      .then(() => process.exit(0));
  });

  log('ready');
}

main();
