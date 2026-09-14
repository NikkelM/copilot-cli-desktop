// Does the live stream carry the description the agent wrote for a tool call?
//
// events.jsonl records intentionSummary on assistant.message tool requests, but the log is
// written by the runtime and may resolve fields the live stream never sends. The status
// line can only use what arrives live, so this asks a throwaway session to run a tool and
// prints every event that mentions a tool request.
//
//   node scripts/probe-intent.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');

const cwd = mkdtempSync(join(tmpdir(), 'ccd-intent-'));
const client = new CopilotClient({ connection: RuntimeConnection.forStdio({}) });

const session = await client.createSession({
  workingDirectory: cwd,
  streaming: true,
  allowAllTools: true,
});

const seen = [];
const finished = new Promise((resolve) => {
  session.on((event) => {
    seen.push(event);
    if (event.type === 'session.idle') resolve();
  });
});

await session.send({
  prompt: 'List the files in the current directory, then tell me how many there are.',
});
await Promise.race([finished, new Promise((r) => setTimeout(r, 120_000))]);

const counts = new Map();
for (const event of seen) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
console.log('--- event types ---');
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), type);

console.log('\n--- assistant.intent ---');
const intents = seen.filter((e) => e.type === 'assistant.intent');
console.log(intents.length ? intents.map((e) => JSON.stringify(e.data)).join('\n') : 'none seen');

console.log('\n--- tool requests on assistant.message ---');
for (const event of seen.filter((e) => e.type === 'assistant.message')) {
  const requests = event.data?.toolRequests;
  if (!Array.isArray(requests) || !requests.length) continue;
  for (const request of requests) {
    console.log(
      `name=${request.name} intentionSummary=${JSON.stringify(request.intentionSummary ?? null)}`,
    );
  }
}

console.log('\n--- any event carrying the words, anywhere in its payload ---');
for (const event of seen) {
  const text = JSON.stringify(event);
  if (text.includes('intentionSummary') || text.includes('"intent"')) {
    console.log(event.type, text.slice(0, 300));
  }
}

await client.dispose?.();
process.exit(0);
