// What the runtime does with messages sent while it is already working.
//
// Three things the SDK's types do not answer, and the queue's design turns on all of them:
//
//   1. Does the runtime run queued messages itself, one turn each?
//   2. Does the id `send()` returns match the `messageId` on the `user.message` event when
//      that message is finally taken? The app must track its own queue - the
//      `pending_messages.modified` event carries no payload and the session exposes no way
//      to ask - so following a message by id rather than by its text depends on this.
//   3. Does stopping a turn drop what is queued behind it?
//
// Requires the app to be running with COPILOT_DESKTOP_DEV_PORT set.
//
//   node scripts/probe-queue.mjs
import { createConnection } from 'node:net';

const PORT = Number(process.env.COPILOT_DESKTOP_DEV_PORT ?? 8791);
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
    }
  }
});

socket.on('error', (error) => {
  console.error(`dev channel error: ${error.message}. Is the app running with COPILOT_DESKTOP_DEV_PORT set?`);
  process.exit(1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await new Promise((resolve) => socket.on('connect', resolve));

const COUNT = 'Count from 1 to 300, one number per line, no other text.';
const start = Date.now();

function timeline(from) {
  const shown = new Set([
    'user.message',
    'assistant.turn_start',
    'assistant.message',
    'assistant.turn_end',
    'abort',
    'session.idle',
    'pending_messages.modified',
  ]);

  for (const event of seen.filter((e) => e.at >= from && shown.has(e.type))) {
    const body = String(event.data?.content ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 45);
    const id = String(event.data?.messageId ?? '-').slice(0, 8);
    console.log(`  +${String(event.at - start).padStart(6)}ms  ${event.type.padEnd(26)} ${id}  ${body}`);
  }
}

const consumedIds = () => seen.filter((e) => e.type === 'user.message').map((e) => e.data?.messageId);

// ---- Left alone, does the runtime work through the queue by itself? ----
const runs = await call('sessions.create', {});
console.log('session', runs.sessionId);

const first = await call('sessions.send', { sessionId: runs.sessionId, prompt: COUNT });
await sleep(4000);
const alpha = await call('sessions.send', { sessionId: runs.sessionId, prompt: 'QUEUED A: say the word alpha.' });
const beta = await call('sessions.send', { sessionId: runs.sessionId, prompt: 'QUEUED B: say the word beta.' });
console.log('send replies:', JSON.stringify({ first, alpha, beta }));

await sleep(45_000);
console.log('\n--- left alone ---');
timeline(start);

console.log('\nthe id from send appears on the user.message event:', consumedIds().includes(first.messageId));
console.log('queued A ran:', consumedIds().includes(alpha.messageId), ' queued B ran:', consumedIds().includes(beta.messageId));
await call('sessions.evict', { sessionId: runs.sessionId }).catch(() => {});

// ---- And when the turn in front is stopped? ----
const stops = await call('sessions.create', {});
const stopFrom = Date.now();
seen.length = 0;

await call('sessions.send', { sessionId: stops.sessionId, prompt: COUNT });
await sleep(4000);
const gamma = await call('sessions.send', { sessionId: stops.sessionId, prompt: 'QUEUED C: say the word gamma.' });
await call('sessions.abort', { sessionId: stops.sessionId });
await sleep(20_000);

console.log('\n--- stopped with one behind it ---');
timeline(stopFrom);
console.log('\nqueued C ran after the stop:', consumedIds().includes(gamma.messageId));

await call('sessions.evict', { sessionId: stops.sessionId }).catch(() => {});
socket.end();
process.exit(0);
