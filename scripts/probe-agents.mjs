// Whether custom agents can be listed without a session, and what the runtime says about them.
//
// The question behind this: #23 wants an agent picker, and the obvious route is the session's
// own `agent.list` - which would mean resuming a session to find out what agents exist, the
// one thing this app is built not to do. The server surface answers instead. `agents.discover`
// is sessionless, so browsing costs nothing and only selecting needs a session.
//
//   node scripts/probe-agents.mjs
import { CopilotClient } from '@github/copilot-sdk';

import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cliPath = resolveCliPath();
if (!cliPath) {
  console.error('no Copilot CLI found');
  process.exit(1);
}

const client = new CopilotClient({ cliPath });
await client.start();

// Where the runtime is willing to look, including directories that do not exist yet.
const { paths } = await client.rpc.agents.getDiscoveryPaths({});
console.log(`${paths.length} discovery paths`);
for (const entry of paths) {
  console.log(`  ${entry.scope ?? '?'}  ${entry.path ?? JSON.stringify(entry)}`);
}

// No project paths: the user-level agents alone, which is what a cold sidebar would show.
const { agents } = await client.rpc.agents.discover({});
console.log(`\n${agents.length} agents discovered with no project path\n`);

const bySource = new Map();
for (const agent of agents) {
  const source = agent.source ?? 'unknown';
  bySource.set(source, (bySource.get(source) ?? 0) + 1);
}
console.log('by source:', JSON.stringify(Object.fromEntries(bySource)), '\n');

for (const agent of agents) {
  const bits = [
    agent.model ? `model=${agent.model}` : null,
    agent.tools?.length ? `tools=${agent.tools.length}` : null,
    agent.skills?.length ? `skills=${agent.skills.length}` : null,
    agent.userInvocable === false ? 'not user invocable' : null,
  ].filter(Boolean);
  console.log(`  ${agent.name}  [${agent.source ?? '?'}]  ${bits.join(' ')}`);
  console.log(`      ${(agent.description ?? '').slice(0, 100)}`);
}

// What a single record actually carries, since the shape decides what a picker can show.
if (agents[0]) {
  console.log('\nfirst record, keys:', Object.keys(agents[0]).join(', '));
}

await client.stop();
process.exit(0);
