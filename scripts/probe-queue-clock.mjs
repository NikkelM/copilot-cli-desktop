// When does the clock under the composer start again?
//
// The elapsed time resets on session.idle. If the runtime picks up a queued message without
// going idle first, the clock keeps counting from the first prompt and reports how long the
// reader has been waiting overall rather than how long this answer has taken.
//
// This sends one message, queues a second while the first is still running, and prints the
// ordering of the events the clock could key off.
//
//   node scripts/probe-queue-clock.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');

const cwd = mkdtempSync(join(tmpdir(), 'ccd-clock-'));
const client = new CopilotClient({ connection: RuntimeConnection.forStdio({}) });
const session = await client.createSession({ workingDirectory: cwd, streaming: true });

const interesting = new Set([
  'user.message',
  'assistant.turn_start',
  'assistant.turn_end',
  'assistant.idle',
  'session.idle',
  'pending_messages.modified',
]);

const seen = [];
const start = Date.now();
let idles = 0;

const finished = new Promise((resolve) => {
  session.on((event) => {
    if (!interesting.has(event.type)) return;
    const at = String(Date.now() - start).padStart(6);
    const extra =
      event.type === 'user.message'
        ? ` content=${JSON.stringify(String(event.data?.content ?? '').slice(0, 40))}`
        : event.type === 'pending_messages.modified'
          ? ` count=${event.data?.messages?.length ?? event.data?.count ?? '?'}`
          : '';
    seen.push(`${at}ms  ${event.type}${extra}  ts=${event.timestamp ?? 'none'}`);
    if (event.type === 'session.idle' && ++idles >= 2) resolve();
  });
});

await session.send({ prompt: 'Count slowly from 1 to 10, one number per line.' });
// Queued rather than sent: the first turn is still running.
await new Promise((r) => setTimeout(r, 1500));
await session.send({ prompt: 'Now say the alphabet backwards.' });

await Promise.race([finished, new Promise((r) => setTimeout(r, 180_000))]);

console.log('--- ordering ---');
for (const line of seen) console.log(line);

console.log('\n--- the question ---');
const firstIdle = seen.findIndex((l) => l.includes('session.idle'));
const secondUser = seen.map((l) => l.includes('user.message')).lastIndexOf(true);
console.log(
  firstIdle === -1 || secondUser === -1
    ? 'could not tell from this run'
    : secondUser > firstIdle
      ? 'the queued message arrives AFTER an idle, so resetting on idle is enough'
      : 'the queued message arrives BEFORE any idle, so resetting on idle leaves the clock running',
);

await client.dispose?.();
process.exit(0);
