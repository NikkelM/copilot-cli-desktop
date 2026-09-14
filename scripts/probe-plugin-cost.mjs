/**
 * What naming the installed plugin directories costs a session (#163).
 *
 * The app exists to be cheaper than a terminal full of sessions, so an option added for
 * correctness still has to justify itself in time, memory and processes.
 */
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { CopilotClient } from '@github/copilot-sdk';
import { resolveCliPath, copilotHome } from '../sidecar/dist/sidecar/src/paths.js';

const cwd = process.cwd();
const ROUNDS = 3;

function footprint() {
  const csv = execSync(
    'powershell -NoProfile -Command "Get-Process copilot -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | ForEach-Object { \\"$($_.Count),$($_.Sum)\\" }"',
    { encoding: 'utf8' },
  ).trim();
  const [count, sum] = csv.split(',');
  return { processes: Number(count || 0), mb: Math.round(Number(sum || 0) / 1048576) };
}

async function measure(label, pluginDirectories) {
  const client = new CopilotClient({ cliPath: resolveCliPath() });
  await client.start();

  const base = { workingDirectory: cwd, enableConfigDiscovery: true, streaming: true };
  const config = pluginDirectories ? { ...base, pluginDirectories } : base;

  const creates = [];
  let skills = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const started = Date.now();
    const session = await client.createSession(config);
    creates.push(Date.now() - started);
    if (i === 0) {
      await session.send({ prompt: 'Reply with the single word ok.' });
      skills = ((await session.rpc.skills.list()).skills ?? []).length;
    }
  }

  const id = await client.getLastSessionId();
  const resumes = [];
  for (let i = 0; i < ROUNDS; i++) {
    const started = Date.now();
    await client.resumeSession(id, config);
    resumes.push(Date.now() - started);
  }

  const after = footprint();
  await client.stop();

  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(
    `${label.padEnd(22)} create ${String(median(creates)).padStart(5)} ms   ` +
      `resume ${String(median(resumes)).padStart(5)} ms   ` +
      `${String(after.processes).padStart(2)} processes   ${String(after.mb).padStart(5)} MB   ` +
      `${skills} skills`,
  );
}

const { plugins } = await client_plugins();
async function client_plugins() {
  const probe = new CopilotClient({ cliPath: resolveCliPath() });
  await probe.start();
  const result = await probe.rpc.plugins.list();
  await probe.stop();
  return result;
}

const dirs = plugins
  .filter((p) => p.enabled !== false)
  .map((p) => join(copilotHome, 'installed-plugins', p.marketplace, p.name));

console.log(`medians over ${ROUNDS} rounds, ${dirs.length} plugin directories\n`);
await measure('without plugin dirs', null);
await measure('with plugin dirs', dirs);
process.exit(0);
