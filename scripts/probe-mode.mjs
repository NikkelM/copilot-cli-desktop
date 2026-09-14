// Which side of the RPC surface mode switching falls on, and what a switch actually reports.
//
// #20 asks for agent/plan/autopilot switching, and #127 found that 40 of the CLI's 56 slash
// commands are drawn by the terminal and never reach the runtime - so the first question is
// whether this app has to build mode switching or only has to follow along.
//
// Two findings worth keeping, both of which cost a wrong conclusion on the way:
//
//   - `mode.set` reports `status: "unchanged"` even when the switch works. That field is
//     about the *model* switch a mode change can trigger, not about the mode. `mode.get()`
//     is the only thing that confirms the mode moved.
//   - Reading the mode back after setting several in a row tells you about the last one.
//     Obvious in hindsight; it read as "mode.set does nothing" for a while.
//
//   node scripts/probe-mode.mjs
import { CopilotClient } from '@github/copilot-sdk';

import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cliPath = resolveCliPath();
if (!cliPath) {
  console.error('no Copilot CLI found');
  process.exit(1);
}

const client = new CopilotClient({ cliPath });
await client.start();

const session = await client.createSession({ workingDirectory: process.cwd(), streaming: true });

const seen = [];
session.on((event) => {
  if (/mode|plan/.test(event.type)) seen.push({ type: event.type, data: event.data });
});

const drain = async (label) => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log(`\n--- events after ${label}`);
  const events = seen.splice(0);
  if (events.length === 0) console.log('    (none)');
  for (const event of events) console.log('   ', event.type, JSON.stringify(event.data));
};

try {
  const { commands = [] } = await session.rpc.commands.list();
  const names = commands.map((command) => command.name);
  console.log(`commands.list() -> ${names.length}`);
  console.log('  mode-ish:', names.filter((name) => /mode|plan|auto/i.test(name)).join(', ') || '(none)');
  console.log('  /plan    :', JSON.stringify(commands.find((command) => command.name === 'plan')));

  console.log('\nmode.get() ->', JSON.stringify(await session.rpc.mode.get()));

  for (const target of ['plan', 'autopilot', 'interactive']) {
    const result = await session.rpc.mode.set({ mode: target });
    console.log(`\nmode.set(${target}) ->`, JSON.stringify(result));
    await drain(`mode.set(${target})`);
    // The one that actually answers whether the switch took.
    console.log('mode.get() ->', JSON.stringify(await session.rpc.mode.get()));
  }

  // The runtime's own command, which is the route the CLI itself takes.
  console.log('\ncommands.invoke(plan) ->', JSON.stringify(await session.rpc.commands.invoke({ name: 'plan', input: '' })));
  await drain('commands.invoke(plan)');
  console.log('mode.get() ->', JSON.stringify(await session.rpc.mode.get()));
} finally {
  await session.disconnect?.();
  await client.stop?.();
}
