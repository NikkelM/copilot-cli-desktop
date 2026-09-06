// Watch what a turn does when it is stopped part way through.
//
// Interrupting is a runtime behaviour, so it can only be seen from a live turn: this drives
// the running app's own sidecar over the dev channel, creates a throwaway session, sends a
// prompt long enough to catch mid-flight, stops it, and prints the event stream around the
// stop. Requires the app to be running with COPILOT_DESKTOP_DEV_PORT set.
//
//   node scripts/probe-abort.mjs
import { createConnection } from 'node:net';

const PORT = Number(process.env.COPILOT_DESKTOP_DEV_PORT ?? 8791);
const STOP_AFTER_MS = Number(process.argv[2] ?? 6000);

const socket = createConnection({ host: '127.0.0.1', port: PORT });
socket.setEncoding('utf8');

let nextId = 1;
const waiting = new Map();
const seen = [];
let buffer = '';

function call(method, params) {
  const id = nextId++;
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

socket.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;

    const message = JSON.parse(line);
    if (message.id !== undefined) {
      const pending = waiting.get(message.id);
      waiting.delete(message.id);
      message.error ? pending?.reject(new Error(JSON.stringify(message.error))) : pending?.resolve(message.result);
    } else if (message.method === 'session.event') {
      seen.push({ at: Date.now(), ...message.params.event });
    } else {
      seen.push({ at: Date.now(), type: `(${message.method})` });
    }
  }
});

socket.on('error', (error) => {
  console.error(`dev channel error: ${error.message}. Is the app running with COPILOT_DESKTOP_DEV_PORT set?`);
  process.exit(1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await new Promise((resolve) => socket.on('connect', resolve));

const { sessionId } = await call('sessions.create', {});
console.log('session', sessionId);

await call('sessions.send', {
  sessionId,
  prompt: 'Count from 1 to 400, one number per line, with no other text.',
});

await sleep(STOP_AFTER_MS);
const stoppedAt = Date.now();
console.log(`--- stopping after ${STOP_AFTER_MS}ms, ${seen.length} events so far ---`);
await call('sessions.abort', { sessionId });

// Long enough to catch anything the runtime sends in response to the stop, and anything
// that carries on regardless, which is the thing worth knowing.
await sleep(12_000);

console.log('\n--- events after the stop ---');
for (const event of seen.filter((e) => e.at >= stoppedAt)) {
  const detail = JSON.stringify(event.data ?? {}).slice(0, 120);
  console.log(`  +${String(event.at - stoppedAt).padStart(6)}ms  ${event.type}  ${detail}`);
}

const counts = new Map();
for (const event of seen) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
console.log('\n--- every event type seen ---');
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), type);

await call('sessions.evict', { sessionId });
socket.end();
process.exit(0);
