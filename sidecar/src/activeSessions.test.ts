import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

vi.mock('./paths.js', () => ({ get copilotHome() { return home; } }));

const { heldSessions } = await import('./activeSessions.js');

/** A session directory, optionally carrying the marker the CLI leaves while it is open. */
function session(id: string, marker?: string): void {
  const dir = join(home, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), '{}\n');
  if (marker) writeFileSync(join(dir, marker), '');
}

/** A pid nothing is using, found by asking rather than by picking a big number. */
function deadPid(): number {
  for (let pid = 60_000; pid < 65_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no free pid to test with');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'active-'));
  mkdirSync(join(home, 'session-state'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Sessions another Copilot has open (#63).
 *
 * The CLI writes `inuse.<pid>.hold` into a session's folder while it is working in it, and
 * never removes it on an unclean exit - so the marker alone says nothing and the pid has to
 * still be running.
 */
describe('finding sessions another Copilot has open', () => {
  it('says nothing where no session has been opened', () => {
    expect(heldSessions()).toEqual([]);
  });

  it('says nothing rather than failing where the CLI has never run', () => {
    rmSync(join(home, 'session-state'), { recursive: true, force: true });

    expect(heldSessions()).toEqual([]);
  });

  it('finds a session whose holder is still running', () => {
    session('open', `inuse.${process.pid}.hold`);

    expect(heldSessions()).toEqual(['open']);
  });

  it('leaves alone a session nobody has open', () => {
    session('idle');

    expect(heldSessions()).toEqual([]);
  });

  /**
   * The case that makes the pid check necessary: measured on this machine, 351 of these
   * markers had been left behind by processes long gone.
   */
  it('ignores a marker left behind by a process that has gone', () => {
    session('crashed', `inuse.${deadPid()}.hold`);

    expect(heldSessions()).toEqual([]);
  });

  /**
   * `.lock` is written beside `.hold` and outlives everything. Counted here: 351 of them,
   * of which 15 named a running pid and 13 of those pids had been recycled by other
   * programs entirely - so a rule built on it would call idle sessions busy.
   */
  it('pays no attention to the lock file beside it', () => {
    session('locked', `inuse.${process.pid}.lock`);

    expect(heldSessions()).toEqual([]);
  });

  it('finds every session that is open, not merely the first', () => {
    session('one', `inuse.${process.pid}.hold`);
    session('two', `inuse.${process.pid}.hold`);
    session('idle');

    expect(heldSessions().sort()).toEqual(['one', 'two']);
  });

  // One session, one answer, however many markers have piled up in its folder.
  it('names a session once even where it holds several markers', () => {
    session('open', `inuse.${process.pid}.hold`);
    writeFileSync(join(home, 'session-state', 'open', `inuse.${deadPid()}.hold`), '');

    expect(heldSessions()).toEqual(['open']);
  });

  it('ignores a file that merely looks like a marker', () => {
    session('odd', 'inuse.hold');
    writeFileSync(join(home, 'session-state', 'odd', 'inuse.notapid.hold'), '');

    expect(heldSessions()).toEqual([]);
  });

  it('ignores a file sitting beside the session directories', () => {
    writeFileSync(join(home, 'session-state', 'stray.txt'), 'not a session');

    expect(heldSessions()).toEqual([]);
  });
});
