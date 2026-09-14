// What the environment viewer in #26 would have to show, and what shape it arrives in.
//
// All three of these live on the sessionless server surface, so the whole viewer can be built
// cold - which is the point, since the question it answers ("why did this session behave like
// that?") is usually asked about a session nobody wants to start.
//
//   node scripts/probe-environment.mjs [cwd]
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

async function show(label, call) {
  try {
    const result = await call();
    const key = Object.keys(result)[0];
    const list = Array.isArray(result[key]) ? result[key] : [];
    console.log(`\n===== ${label} =====`);
    console.log(`  top-level keys: ${Object.keys(result).join(', ')}`);
    console.log(`  ${list.length} entries under "${key}"`);
    if (list[0]) console.log(`  record keys: ${Object.keys(list[0]).join(', ')}`);
    for (const entry of list.slice(0, 8)) {
      console.log(`    ${JSON.stringify(entry).slice(0, 220)}`);
    }
  } catch (error) {
    console.log(`\n===== ${label} =====\n  failed: ${error?.message ?? error}`);
  }
}

await show('instructions.discover', () => client.rpc.instructions.discover({ projectPaths: [cwd] }));
await show('plugins.list', () => client.rpc.plugins.list());
await show('extensions.discover', () => client.rpc.extensions.discover());
await show('skills.discover', () => client.rpc.skills.discover({ projectPaths: [cwd] }));

await client.stop();
process.exit(0);
