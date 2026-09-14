// What config discovery costs, since this app exists to not spend what the CLI spends.
//
// Turning it on is what makes a session see the reader's agents, skills and instructions, so
// it has to go on. The question is the price: it also loads MCP servers, which are processes,
// and this app's whole premise is not paying for sessions nobody is using. Measures creation
// and resume both ways, and counts what is running underneath.
//
//   node scripts/probe-discovery-cost.mjs [cwd]
import { execFileSync } from 'node:child_process';

import { CopilotClient } from '@github/copilot-sdk';

import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cwd = process.argv[2] ?? process.cwd();

const cliPath = resolveCliPath();
if (!cliPath) {
  console.error('no Copilot CLI found');
  process.exit(1);
}

/** Every descendant of this process, which is what a session actually costs the machine. */
function descendants() {
  const script = `
    $ids = New-Object System.Collections.Generic.HashSet[int]
    [void]$ids.Add(${process.pid})
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize, Name
    for ($i = 0; $i -lt 6; $i++) {
      foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } }
    }
    $mine = $all | Where-Object { $ids.Contains([int]$_.ProcessId) -and [int]$_.ProcessId -ne ${process.pid} }
    "$($mine.Count) $((($mine | Measure-Object WorkingSetSize -Sum).Sum) / 1MB)"
  `;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
  const [count, mb] = out.split(' ');
  return { count: Number(count), mb: Math.round(Number(mb)) };
}

async function measure(label, config, resumeId) {
  const client = new CopilotClient({ cliPath });
  await client.start();

  const startedCreate = Date.now();
  const session = await client.createSession({ workingDirectory: cwd, ...config });
  const created = Date.now() - startedCreate;

  // Let anything the session starts in the background actually get going before counting.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const after = descendants();

  const agents = ((await session.rpc.agent.list()).agents ?? []).length;
  let mcp = 'n/a';
  try {
    const listed = await session.rpc.mcp.list();
    mcp = String((listed.servers ?? []).length);
  } catch (error) {
    mcp = `failed: ${String(error?.message ?? error).slice(0, 60)}`;
  }

  await client.stop();

  // Resuming is the path that matters: it is what the sidebar does every time one is opened.
  // A session of the reader's own, because one just created has no turns and was never
  // written to disk, so there is nothing to resume.
  let resumed = 'no session to resume';
  if (resumeId) {
    const second = new CopilotClient({ cliPath });
    await second.start();
    const startedResume = Date.now();
    await second.resumeSession(resumeId, config);
    resumed = `${Date.now() - startedResume} ms`;
    await second.stop();
  }

  console.log(`\n=== ${label} ===`);
  console.log(`  create:      ${created} ms`);
  console.log(`  resume:      ${resumed}`);
  console.log(`  processes:   ${after.count} using ${after.mb} MB`);
  console.log(`  agents:      ${agents}`);
  console.log(`  mcp servers: ${mcp}`);
}

// Whatever was last worked in, which is a real session with real history behind it.
const finder = new CopilotClient({ cliPath });
await finder.start();
const resumeId = await finder.getLastSessionId();
await finder.stop();
console.log(`resuming ${resumeId ?? 'nothing: no previous session found'}`);

await measure('as this app creates sessions today', {}, resumeId);
await measure('with enableConfigDiscovery', { enableConfigDiscovery: true }, resumeId);

process.exit(0);
