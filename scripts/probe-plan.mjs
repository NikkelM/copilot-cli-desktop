import { CopilotClient } from '@github/copilot-sdk';
import { writeFile, unlink } from 'node:fs/promises';
import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cliPath = resolveCliPath();
if (!cliPath) throw new Error('No Copilot CLI found');
const client = new CopilotClient({ cliPath });
await client.start();
let session;
try {
  session = await client.createSession({
    workingDirectory: process.cwd(),
    onPermissionRequest: () => ({ kind: 'denied-interactively-by-user' }),
    onExitPlanModeRequest: () => ({ approved: true, selectedAction: 'exit_only' }),
  });
  console.log('session', session.sessionId);
  session.on((event) => {
    if (/plan|workspace/.test(event.type)) console.log('event', JSON.stringify(event));
    if (process.argv.includes('--agent') && /tool.execution_start|tool.execution_complete/.test(event.type)) {
      console.log('tool', JSON.stringify(event));
    }
  });
  const read = async (label) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const result = await session.rpc.plan.read();
    console.log(label, JSON.stringify(result));
    return result;
  };
  await read('initial');
  if (process.argv.includes('--agent')) {
    await session.rpc.mode.set({ mode: 'plan' });
    await session.sendAndWait({
      prompt: 'Plan a tiny standalone calculator that adds two numbers. This is a plan-only test: do not implement, inspect this repository, run shell commands, or ask questions. Use sensible defaults and finish the plan.',
    }, 120_000);
    await read('after agent planning');
  }
  await session.rpc.plan.update({ content: '# Probe plan\n\nFirst revision\n' });
  const plan = await read('after RPC create');
  if (!plan.path) throw new Error('Plan has no resolved path');
  await session.rpc.plan.update({ content: '# Probe plan\n\nSecond revision\n' });
  await read('after RPC update');
  await writeFile(plan.path, '# Probe plan\n\nFilesystem revision\n');
  await read('after direct file update');
  await unlink(plan.path);
  await read('after direct file delete');
  await session.rpc.plan.update({ content: '# Temporary probe\n' });
  await read('after recreate');
  await session.rpc.plan.delete();
  await read('after RPC delete');
} finally {
  if (session) {
    await session.disconnect();
    await client.deleteSession(session.sessionId);
  }
  await client.stop();
}
