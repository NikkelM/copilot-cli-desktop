// Find out what the CLI will tell us about its slash commands.
//
// The issue for this (#19) assumed the list arrives on an `available_commands_update` event,
// which would mean it is only knowable once a session is live. The SDK also carries a
// `CommandsListRequest` type, which suggests it can simply be asked - a much better fit for
// this app, where a session is deliberately not resumed until the first send.
//
// This drives the SDK directly rather than the app's sidecar, because the question is what
// the SDK offers rather than what this app currently does with it.
//
//   node scripts/probe-commands.mjs
import { CopilotClient } from '@github/copilot-sdk';

import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cliPath = resolveCliPath();
if (!cliPath) {
  console.error('no Copilot CLI found');
  process.exit(1);
}

const client = new CopilotClient({ cliPath });
await client.start();
console.log('server started');

const session = await client.createSession({ workingDirectory: process.cwd() });
console.log('session', session.id);

// Everything the session announces, so an event-carried list would show up here too.
const events = [];
session.on('*', (event) => {
  events.push(event);
  if (/command/i.test(event.type ?? '')) {
    console.log('EVENT', event.type, JSON.stringify(event.data).slice(0, 300));
  }
});

const namespaces = Object.keys(session.rpc ?? {});
console.log('rpc namespaces:', namespaces.join(', '));

if (session.rpc?.commands) {
  console.log('commands methods:', Object.keys(session.rpc.commands).join(', '));

  for (const request of [
    { includeBuiltins: true, includeSkills: true, includeClientCommands: true },
    undefined,
  ]) {
    try {
      const result = await session.rpc.commands.list(request);
      const list = result?.commands ?? result;
      console.log(`\ncommands.list(${JSON.stringify(request)}) ->`, Array.isArray(list) ? `${list.length} commands` : typeof list);
      for (const command of (Array.isArray(list) ? list : []).slice(0, 8)) {
        console.log('   ', JSON.stringify(command));
      }
      break;
    } catch (error) {
      console.log(`commands.list(${JSON.stringify(request)}) failed:`, error.message);
    }
  }
}

console.log('\nevent types seen:', [...new Set(events.map((e) => e.type))].join(', '));

await client.stop();
process.exit(0);
