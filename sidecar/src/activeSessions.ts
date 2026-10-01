import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { copilotHome } from './paths.js';

/** `inuse.<pid>.hold`, which the CLI leaves in a session's directory while it has it open. */
const HOLD = /^inuse\.(\d+)\.hold$/;

/**
 * Whether a process is still there, without caring whose it is.
 *
 * Signal zero asks the question without sending anything. A process owned by another user
 * answers `EPERM`, which is a refusal to signal it rather than a claim it is gone - so that
 * counts as running, where `ESRCH` is the one that means nobody is home.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Sessions some other Copilot has open, by the marker the CLI itself leaves (#63).
 *
 * The CLI writes `inuse.<pid>.hold` into a session's directory while it is working in it.
 * Reading that is the whole mechanism - no process is started and nothing is asked of the
 * runtime, which is what lets this answer for every session on disk rather than only the
 * ones this app has opened.
 *
 * The file alone is not evidence. Measured on this machine: 351 of those markers were left
 * behind by processes that are long gone, because an unclean exit never removes them. The
 * pid has to still be running for the marker to mean anything.
 *
 * Nor is the `.lock` file beside it, which is why this only reads `.hold`. The same
 * measurement found 15 sessions whose `.lock` pid was running, and 13 of those pids had
 * been recycled by Chrome, Edge and Discord - so a rule built on `.lock` would have called
 * thirteen idle sessions busy. Only four sessions carried a `.hold` at all, and exactly the
 * two genuinely open ones were still running.
 *
 * That leaves pid reuse as the one way this can be wrong, and it is worth the trade: being
 * wrong shows a warning beside a session nobody is using, where the alternative is silence
 * while two Copilots write to one conversation.
 */
export function heldSessions(): string[] {
  const root = join(copilotHome, 'session-state');

  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    // No directory at all is a CLI that has never run, not a failure worth reporting.
    return [];
  }

  const held: string[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    let names;
    try {
      names = readdirSync(join(root, dir.name));
    } catch {
      // Gone or unreadable between listing and looking, which says nothing about whether
      // anybody has it open.
      continue;
    }

    for (const name of names) {
      const pid = HOLD.exec(name)?.[1];
      if (pid && alive(Number(pid))) {
        held.push(dir.name);
        break;
      }
    }
  }

  return held;
}
