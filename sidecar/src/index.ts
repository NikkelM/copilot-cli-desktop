/**
 * Node sidecar: owns all Copilot CLI interaction and speaks newline-delimited
 * JSON-RPC over stdio to the Tauri shell.
 *
 * It lives in Node rather than Rust because @github/copilot-sdk is TypeScript and
 * ships bundled with the CLI, which keeps the SDK and CLI versions in lockstep.
 */
import { createInterface } from 'node:readline';

import type { JsonRpcRequest, JsonRpcResponse } from '../../shared/protocol.js';
import { readTranscript } from './eventLog.js';
import { SessionRuntime } from './runtime.js';
import { listSessions } from './sessionIndex.js';

const runtime = new SessionRuntime();

/** Anything written to stdout is protocol, so diagnostics must go to stderr. */
function log(message: string): void {
  process.stderr.write(`[sidecar] ${message}\n`);
}

function reply(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

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
      const params = request.params as { sessionId: string; limit?: number };
      return readTranscript(params.sessionId, params.limit);
    }

    case 'runtime.status':
      return runtime.status();

    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}

function main(): void {
  const { cliPath, sdkPath } = SessionRuntime.probeInstallation();
  log(cliPath ? `CLI: ${cliPath}` : 'CLI not found - set COPILOT_CLI_PATH');
  log(sdkPath ? `SDK: ${sdkPath}` : 'bundled SDK not found');

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

  // Drain outstanding work before exiting, so a request issued just before stdin
  // closes still gets a response.
  rl.on('close', () => {
    void Promise.allSettled([...inFlight]).then(() => process.exit(0));
  });

  log('ready');
}

main();
