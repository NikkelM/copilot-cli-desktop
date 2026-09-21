import { describe, expect, it, vi } from 'vitest';

/**
 * The CLI updates itself on startup by default, and never when this app launches it: the
 * SDK spawns it with `--no-auto-update` every time, which is not ours to change. So this
 * runs the CLI's own `update` command instead (#199).
 */

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

const { resolveCliPath } = vi.hoisted(() => ({
  resolveCliPath: vi.fn((): string | null => 'C:\\copilot.exe'),
}));
vi.mock('./paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveCliPath,
}));

/** `promisify` reads the callback off the mock, so each test says how the call ends. */
function answers(result: { stdout?: string; stderr?: string } | Error) {
  execFile.mockImplementation((_path: string, _args: string[], _options: unknown, done: unknown) => {
    const callback = done as (error: Error | null, out?: { stdout: string; stderr: string }) => void;
    if (result instanceof Error) callback(result);
    else callback(null, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  });
}

async function load() {
  vi.resetModules();
  execFile.mockReset();
  resolveCliPath.mockReset().mockReturnValue('C:\\copilot.exe');
  return import('./updateCli.js');
}

describe('updating the CLI', () => {
  it('runs the CLI own update command', async () => {
    const { updateCli } = await load();
    answers({ stdout: 'Already up to date.' });

    const result = await updateCli();

    expect(execFile).toHaveBeenCalledWith('C:\\copilot.exe', ['update'], expect.anything(), expect.anything());
    expect(result).toEqual({ ran: true, said: 'Already up to date.' });
  });

  it('keeps what it said, from either stream', async () => {
    const { updateCli } = await load();
    answers({ stdout: 'Downloading 1.2.3', stderr: 'a warning' });

    expect((await updateCli()).said).toBe('Downloading 1.2.3a warning');
  });

  it('says it ran even when it said nothing', async () => {
    const { updateCli } = await load();
    answers({ stdout: '  \n' });

    expect(await updateCli()).toEqual({ ran: true });
  });

  /** Nothing waits on this, so a machine that is offline must not hold the app up. */
  it('gives up rather than waiting forever', async () => {
    const { updateCli } = await load();
    answers({ stdout: '' });

    await updateCli();

    expect(execFile.mock.calls[0]![2]).toEqual(expect.objectContaining({ timeout: 5 * 60_000 }));
  });

  it('reports a failure rather than throwing it', async () => {
    const { updateCli } = await load();
    answers(new Error('network is unreachable'));

    expect(await updateCli()).toEqual({ ran: false, failed: 'network is unreachable' });
  });

  it('asks nothing when there is no CLI to ask', async () => {
    const { updateCli } = await load();
    resolveCliPath.mockReturnValue(null);

    expect(await updateCli()).toEqual({ ran: false, failed: 'the CLI could not be found' });
    expect(execFile).not.toHaveBeenCalled();
  });
});
