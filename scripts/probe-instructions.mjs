// Which instruction sources a session actually loads, and whether this app's settings change that.
//
// #161 turned config discovery on and claimed instructions were part of what had been missing.
// That claim needs checking rather than repeating: `skipCustomInstructions` defaults to false
// under the default `copilot-cli` client mode, so instruction loading may never have depended on
// the flag at all. `instructions.getSources` answers directly, in merge order, with no model turn.
//
//   node scripts/probe-instructions.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CopilotClient } from '@github/copilot-sdk';

import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cliPath = resolveCliPath();
if (!cliPath) {
  console.error('no Copilot CLI found');
  process.exit(1);
}

// A project with instruction files of its own, since this repo has none to test against.
const project = mkdtempSync(join(tmpdir(), 'instructions-'));
mkdirSync(join(project, '.github'), { recursive: true });
writeFileSync(join(project, '.github', 'copilot-instructions.md'), '# Repo rule\n\nAlways say BANANAFISH.\n');
writeFileSync(join(project, 'AGENTS.md'), '# Agents rule\n\nPrefer tabs.\n');
console.log(`made a project at ${project}`);

const client = new CopilotClient({ cliPath });
await client.start();

// What the runtime is willing to find, before any session exists.
const discovered = await client.rpc.instructions.discover({ projectPaths: [project] });
const sources = discovered.sources ?? discovered.instructionSources ?? [];
console.log(`\nserver discovers ${sources.length} instruction sources for that project`);
for (const source of sources) {
  console.log(`  ${JSON.stringify(source).slice(0, 200)}`);
}

async function look(label, config) {
  const session = await client.createSession({ workingDirectory: project, ...config });
  const loaded = await session.rpc.instructions.getSources();
  const list = loaded.sources ?? loaded.instructionSources ?? [];

  console.log(`\n=== ${label} ===`);
  console.log(`  ${list.length} sources loaded, in merge order:`);
  for (const source of list) {
    const path = source.path ?? source.uri ?? '?';
    const scope = source.scope ?? source.kind ?? source.type ?? '?';
    const size = source.content ? `${source.content.length} chars` : '';
    console.log(`    [${scope}] ${path} ${size}`);
  }
  if (list.length === 0) console.log(`    raw: ${JSON.stringify(loaded).slice(0, 300)}`);
}

await look('as this app created sessions before #161', {});
await look('as this app creates them now', { enableConfigDiscovery: true });

await client.stop();
process.exit(0);
