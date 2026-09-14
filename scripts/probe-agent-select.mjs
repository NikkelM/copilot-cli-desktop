// Why a session refuses an agent the server just discovered.
//
// The picker from #23 lists agents through the sessionless `agents.discover`, then selects one
// through the session's `agent.select`. A real selection failed with "Custom agent 'deep-audit'
// not found", so the two surfaces disagree about either which agents exist or what to call
// them. This asks both and prints the difference.
//
//   node scripts/probe-agent-select.mjs [cwd]
import { CopilotClient } from '@github/copilot-sdk';

import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cwd = process.argv[2] ?? process.cwd();

const cliPath = resolveCliPath();
if (!cliPath) {
  console.error('no Copilot CLI found');
  process.exit(1);
}

const client = new CopilotClient({ cliPath });
await client.start();

const discovered = (await client.rpc.agents.discover({ projectPaths: [cwd] })).agents;
console.log(`server discovered ${discovered.length} agents for ${cwd}`);
for (const agent of discovered) {
  console.log(`  name=${JSON.stringify(agent.name)} id=${JSON.stringify(agent.id)} source=${agent.source}`);
}

// A session of its own rather than one of the reader's, so nothing real is changed by this.
const session = await client.createSession({ cwd });
console.log(`\nsession ${session.id} created in ${cwd}`);

const listed = (await session.rpc.agent.list()).agents ?? [];
console.log(`\nsession lists ${listed.length} custom agents`);
for (const agent of listed) {
  console.log(`  name=${JSON.stringify(agent.name)} id=${JSON.stringify(agent.id)} source=${agent.source}`);
}

// Whether the session simply had not looked yet, which would make this a refresh problem
// rather than a naming one.
const reloaded = (await session.rpc.agent.reload()).agents ?? [];
console.log(`\nafter reload the session lists ${reloaded.length}`);
for (const agent of reloaded) {
  console.log(`  name=${JSON.stringify(agent.name)} id=${JSON.stringify(agent.id)} source=${agent.source}`);
}

// Which key `select` actually wants, tried against whatever the server offered first.
const candidate = discovered[0];
if (candidate) {
  for (const [label, value] of [
    ['name', candidate.name],
    ['id', candidate.id],
    ['displayName', candidate.displayName],
  ]) {
    if (!value) continue;
    try {
      const result = await session.rpc.agent.select({ name: value });
      console.log(`\nselect by ${label} (${JSON.stringify(value)}) worked:`, JSON.stringify(result));
      await session.rpc.agent.deselect();
    } catch (error) {
      console.log(`\nselect by ${label} (${JSON.stringify(value)}) failed: ${error?.message ?? error}`);
    }
  }
}

await client.stop();
process.exit(0);
