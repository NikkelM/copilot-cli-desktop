// What skills management in #22 can actually do, and which half of it needs a session.
//
// Two surfaces claim to answer "what skills are there": the sessionless `skills.discover` and
// the per-session `skills.list`. Toggling has two more: a session-scoped enable/disable and a
// global config write. Which of those persists decides what a toggle in the UI can honestly
// promise, so it is measured here rather than assumed.
//
//   node scripts/probe-skills.mjs [cwd]
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

const line = (label) => console.log(`\n===== ${label} =====`);

line('skills.discover (no session)');
const discovered = await client.rpc.skills.discover({ projectPaths: [cwd] });
console.log(`  top-level keys: ${Object.keys(discovered).join(', ')}`);
console.log(`  ${discovered.skills.length} skills`);
console.log(`  record keys: ${Object.keys(discovered.skills[0] ?? {}).join(', ')}`);
for (const skill of discovered.skills.slice(0, 6)) console.log(`    ${JSON.stringify(skill).slice(0, 240)}`);
const sources = {};
for (const skill of discovered.skills) sources[skill.source] = (sources[skill.source] ?? 0) + 1;
console.log(`  by source: ${JSON.stringify(sources)}`);
console.log(`  enabled: ${discovered.skills.filter((s) => s.enabled).length}`);
console.log(`  invocable: ${discovered.skills.filter((s) => s.userInvocable).length}`);

line('skills.getDiscoveryPaths');
try {
  const paths = await client.rpc.skills.getDiscoveryPaths({ projectPaths: [cwd] });
  for (const path of paths.paths) console.log(`    ${JSON.stringify(path)}`);
} catch (error) {
  console.log(`  failed: ${error?.message ?? error}`);
}

line('session.rpc.skills.list (needs a session)');
const session = await client.createSession({ workingDirectory: cwd, enableConfigDiscovery: true, streaming: true });
const listed = await session.rpc.skills.list();
console.log(`  ${listed.skills.length} skills`);
console.log(`  record keys: ${Object.keys(listed.skills[0] ?? {}).join(', ')}`);
const onlyInSession = listed.skills.filter((s) => !discovered.skills.some((d) => d.name === s.name));
const onlyInDiscover = discovered.skills.filter((d) => !listed.skills.some((s) => s.name === d.name));
console.log(`  in session but not discover: ${onlyInSession.map((s) => s.name).join(', ') || 'none'}`);
console.log(`  in discover but not session: ${onlyInDiscover.map((s) => s.name).join(', ') || 'none'}`);

const victim = listed.skills.find((s) => s.enabled && s.userInvocable);
console.log(`  toggling: ${victim?.name ?? 'nothing enabled to try'}`);

if (victim) {
  line('session.rpc.skills.disable then list again');
  await session.rpc.skills.disable({ name: victim.name });
  const after = await session.rpc.skills.list();
  const seen = after.skills.find((s) => s.name === victim.name);
  console.log(`  enabled after disable: ${seen?.enabled}`);

  line('does a session disable leak into the sessionless view?');
  const again = await client.rpc.skills.discover({ projectPaths: [cwd] });
  console.log(`  discover still enabled: ${again.skills.find((s) => s.name === victim.name)?.enabled}`);

  line('does it survive a cold resume?');
  const id = session.sessionId;
  await session.stop?.();
  const resumed = await client.resumeSession(id, { enableConfigDiscovery: true, streaming: true });
  const afterResume = await resumed.rpc.skills.list();
  console.log(`  enabled after resume: ${afterResume.skills.find((s) => s.name === victim.name)?.enabled}`);
  await resumed.rpc.skills.enable({ name: victim.name });
  console.log(`  re-enabled: ${(await resumed.rpc.skills.list()).skills.find((s) => s.name === victim.name)?.enabled}`);

  line('session.rpc.skills.getInvoked');
  console.log(`  ${JSON.stringify(await resumed.rpc.skills.getInvoked()).slice(0, 200)}`);

  line('session.rpc.skills.reload');
  console.log(`  ${JSON.stringify(await resumed.rpc.skills.reload()).slice(0, 300)}`);
}

await client.stop();
process.exit(0);
