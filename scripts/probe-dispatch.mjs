// Find out how a slash command actually runs, and where its output goes.
//
// The commands namespace offers four plausible entry points - invoke, execute, enqueue and
// handlePendingCommand - and the answer decides the shape of everything downstream: whether
// output arrives as session events the transcript already renders, or as a return value the
// app has to render itself.
//
//   node scripts/probe-dispatch.mjs
import { CopilotClient } from '@github/copilot-sdk';

import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cliPath = resolveCliPath();
if (!cliPath) {
  console.error('no Copilot CLI found');
  process.exit(1);
}

const client = new CopilotClient({ cliPath });
await client.start();

// Can the list be had without a session at all? That would let a cold session offer
// autocomplete without resuming anything.
try {
  const cold = await client.rpc.commands.list();
  const names = (cold?.commands ?? []).map((c) => c.name);
  console.log(`client-level commands.list() -> ${names.length}:`, names.join(', '));
} catch (error) {
  console.log('client-level commands.list() failed:', error.message);
}

const session = await client.createSession({ workingDirectory: process.cwd() });

const events = [];
session.on('*', (event) => {
  events.push(event);
});

const warm = await session.rpc.commands.list();
console.log(`\nsession commands.list() -> ${warm.commands.length}`);
for (const command of warm.commands) {
  console.log(
    `  /${command.name}${command.input ? ` <${command.input.hint}>` : ''}`,
    `[${command.kind}${command.allowDuringAgentExecution ? ', during-turn' : ''}]`,
    command.aliases?.length ? `aliases=${command.aliases.join(',')}` : '',
  );
}

for (const name of ['help', 'usage', 'session']) {
  events.length = 0;
  try {
    const result = await session.rpc.commands.invoke({ name });
    const shown = JSON.stringify(result);
    console.log(`\ninvoke(${name}) -> kind=${result?.kind} ${shown.slice(0, 400)}`);
  } catch (error) {
    console.log(`\ninvoke(${name}) failed:`, error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log(`  events during invoke: ${events.map((e) => e.type).join(', ') || 'none'}`);
}

await client.stop();
process.exit(0);
