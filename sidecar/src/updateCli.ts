import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveCliPath } from './paths.js';

const run = promisify(execFile);

/**
 * Bring the Copilot CLI up to date, if the reader asked for that.
 *
 * The CLI updates itself on startup by default, and this app never gets that: the SDK
 * spawns it with `--no-auto-update` every time, which is not ours to change. So a reader
 * who wants a current CLI has to be given a way to say so, and this is it - the CLI's own
 * `update` command, run once as the app starts (#199).
 *
 * Deliberately not fatal and deliberately not waited on by anything: the app works with
 * the CLI it has, and a machine that is offline should not have a slower start because of
 * a setting about updates. Five minutes is well past a download and well short of forever.
 */
const TIMEOUT_MS = 5 * 60_000;

export interface UpdateResult {
  /** Whether the CLI was asked at all, which it is not when it cannot be found. */
  ran: boolean;
  /** What it said, trimmed, for the log. Absent when it said nothing. */
  said?: string;
  /** Why it did not happen, for the log. Absent when it did. */
  failed?: string;
}

export async function updateCli(): Promise<UpdateResult> {
  const cliPath = resolveCliPath();
  if (!cliPath) return { ran: false, failed: 'the CLI could not be found' };

  try {
    const { stdout, stderr } = await run(cliPath, ['update'], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    const said = `${stdout}${stderr}`.trim();
    return said ? { ran: true, said } : { ran: true };
  } catch (error) {
    return { ran: false, failed: error instanceof Error ? error.message : String(error) };
  }
}
