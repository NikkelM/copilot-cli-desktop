// What a session knows when config discovery is off, which is the default, against when it is on.
//
// The agent picker from #23 could list agents but not select one: the session answered "Custom
// agent 'deep-audit' not found" for an agent the server had just discovered. The session was not
// wrong - it genuinely knew none. `SessionConfigBase.enableConfigDiscovery` defaults to false,
// and this app has never set it, so sessions have been running without the reader's agents and
// quite possibly without their instructions too.
//
//   node scripts/probe-config-discovery.mjs [cwd]
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

async function look(label, config) {
  const session = await client.createSession({ workingDirectory: cwd, ...config });

  const agents = (await session.rpc.agent.list()).agents ?? [];
  const withBuiltIns = (await session.rpc.agent.list({ includeBuiltInAgents: true })).agents ?? [];

  let skills = 'n/a';
  try {
    skills = String(((await session.rpc.skills.list()).skills ?? []).length);
  } catch (error) {
    skills = `failed: ${error?.message ?? error}`;
  }

  let instructions = 'n/a';
  try {
    const found = await session.rpc.instructions.list();
    instructions = String((found.instructions ?? found.sources ?? []).length);
  } catch (error) {
    instructions = `failed: ${error?.message ?? error}`;
  }

  let selected = 'not tried';
  if (agents.length > 0) {
    try {
      await session.rpc.agent.select({ name: agents[0].name });
      selected = `selected ${agents[0].name}`;
      await session.rpc.agent.deselect();
    } catch (error) {
      selected = `failed: ${error?.message ?? error}`;
    }
  }

  console.log(`\n=== ${label} ===`);
  console.log(`  custom agents:        ${agents.length}`);
  console.log(`  with built-ins:       ${withBuiltIns.length}`);
  console.log(`  skills:               ${skills}`);
  console.log(`  instruction sources:  ${instructions}`);
  console.log(`  select:               ${selected}`);
  if (agents.length > 0) console.log(`  first few:            ${agents.slice(0, 4).map((a) => a.name).join(', ')}`);

  return session;
}

await look('as this app creates sessions today', {});
await look('with enableConfigDiscovery', { enableConfigDiscovery: true });

await client.stop();
process.exit(0);
