// Drive the running app's sidecar over the dev channel.
//
// The app owns its sidecar over stdio, so there is no other way to script it: starting
// a second sidecar would start a second CLI server that the running app never sees.
// Requests sent here are handled by the app's own sidecar, so its notifications reach
// the UI exactly as they would for a real interaction.
//
// Requires the app to have been started with COPILOT_DESKTOP_DEV_PORT set.
//
// Usage:
//   node scripts/drive.mjs runtime.status
//   node scripts/drive.mjs sessions.send '{"sessionId":"<id>","prompt":"hello"}' 30000
import { createConnection } from 'node:net';

const PORT = Number(process.env.COPILOT_DESKTOP_DEV_PORT ?? 8791);
const method = process.argv[2];
const params = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const waitMs = Number(process.argv[4] ?? 8000);

if (!method) {
  console.error('usage: node scripts/drive.mjs <method> [jsonParams] [waitMs]');
  process.exit(1);
}

const socket = createConnection({ host: '127.0.0.1', port: PORT });
const notifications = [];
let buffer = '';

socket.setEncoding('utf8');

socket.on('connect', () => {
  console.log(`connected to dev channel on 127.0.0.1:${PORT}`);
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
});

socket.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message.id !== undefined) {
      const payload = message.error ?? message.result;
      // A void RPC replies with a null result, which JSON.stringify renders as undefined.
      console.log('RESPONSE ' + (payload === undefined || payload === null ? 'ok' : JSON.stringify(payload).slice(0, 600)));
    } else if (message.method) {
      notifications.push(message);
      if (message.method === 'permission.requested') {
        const { request } = message.params;
        console.log(`  PERMISSION ${request.kind}: ${request.fullCommandText ?? request.intention ?? ''}`);
      }
    }
  }
});

socket.on('error', (error) => {
  console.error(`dev channel error: ${error.message}`);
  console.error('Is the app running with COPILOT_DESKTOP_DEV_PORT set?');
  process.exit(1);
});

setTimeout(() => {
  const counts = {};
  for (const notification of notifications) {
    const key =
      notification.method === 'session.event' ? notification.params.event.type : notification.method;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(`notifications: ${JSON.stringify(counts)}`);
  socket.end();
  process.exit(0);
}, waitMs);
