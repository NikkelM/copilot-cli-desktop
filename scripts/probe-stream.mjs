// Observe the live event stream, which the log does not record.
//
// Streaming deltas are ephemeral: they never reach events.jsonl, so their shape can only
// be seen from a live turn. This creates a throwaway session in a temp directory rather
// than touching any real one.
//
//   node scripts/probe-stream.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');

const cwd = mkdtempSync(join(tmpdir(), 'ccd-probe-'));
const client = new CopilotClient({ connection: RuntimeConnection.forStdio({}) });

const session = await client.createSession({ workingDirectory: cwd, streaming: true });

const seen = [];
// send() only queues the message; the turn plays out over the event stream afterwards.
const finished = new Promise((resolve) => {
  session.on((event) => {
    seen.push(event);
    if (event.type === 'session.idle' || event.type === 'assistant.turn_end') resolve();
  });
});

await session.send({ prompt: 'Write a single paragraph of about 60 words about the sea. No preamble.' });
await Promise.race([finished, new Promise((r) => setTimeout(r, 90_000))]);

// Group by type, and show one example of anything that looks like a delta.
const counts = new Map();
for (const event of seen) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);

console.log('--- event types ---');
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), type);

const delta = seen.find((e) => e.type === 'assistant.message_delta');
console.log('\n--- first message_delta ---');
console.log(delta ? JSON.stringify(delta, null, 2).slice(0, 900) : 'none seen');

const deltas = seen.filter((e) => e.type === 'assistant.message_delta');
console.log('\n--- all message_delta payloads ---');
for (const d of deltas) console.log(JSON.stringify(d.data ?? d));

console.log('\n--- message_start ---');
const started = seen.find((e) => e.type === 'assistant.message_start');
console.log(started ? JSON.stringify(started.data) : 'none seen');

const final = seen.find((e) => e.type === 'assistant.message');
console.log('\n--- final assistant.message ---');
console.log(final ? JSON.stringify(final, null, 2).slice(0, 700) : 'none seen');

await client.dispose?.();
process.exit(0);
