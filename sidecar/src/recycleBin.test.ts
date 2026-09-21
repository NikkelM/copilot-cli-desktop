import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let home: string;
let data: string;

/** Loaded fresh each time, since the paths module reads COPILOT_HOME as it is imported. */
async function load() {
  vi.resetModules();
  return import('./recycleBin.js');
}

/** A session on disk, as the CLI leaves one: a directory with a transcript in it. */
function makeSession(sessionId: string, text = 'hello\n') {
  const dir = join(home, 'session-state', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), text, 'utf8');
  return dir;
}

const binned = (sessionId: string) => join(data, 'recycle-bin', sessionId);
const note = (sessionId: string) => join(data, 'recycle-bin', `${sessionId}.json`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bin-'));
  home = join(root, 'copilot');
  data = join(root, 'app');
  mkdirSync(join(home, 'session-state'), { recursive: true });
  mkdirSync(data, { recursive: true });
  process.env.COPILOT_HOME = home;
  process.env.COPILOT_DESKTOP_DATA = data;
});

afterEach(() => {
  delete process.env.COPILOT_HOME;
  delete process.env.COPILOT_DESKTOP_DATA;
  rmSync(root, { recursive: true, force: true });
});

describe('binning a session', () => {
  it('moves the directory out of where the CLI looks', async () => {
    const { binSession } = await load();
    const from = makeSession('doomed');

    expect(binSession('doomed', 'A session', '2026-01-02T03:04:05Z')).toBe(true);

    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(binned('doomed'), 'events.jsonl'), 'utf8')).toBe('hello\n');
  });

  // The whole promise of a bin: what was deleted is still there.
  it('keeps everything the session wrote', async () => {
    const { binSession } = await load();
    mkdirSync(join(home, 'session-state', 'doomed', 'rewind'), { recursive: true });
    writeFileSync(join(home, 'session-state', 'doomed', 'rewind', 'snap'), 'x', 'utf8');
    makeSession('doomed');

    binSession('doomed', null, null);

    expect(readFileSync(join(binned('doomed'), 'rewind', 'snap'), 'utf8')).toBe('x');
  });

  it('remembers what it was, beside it rather than in it', async () => {
    const { binSession } = await load();
    makeSession('doomed');

    binSession('doomed', 'A session', '2026-01-02T03:04:05Z');

    const kept = JSON.parse(readFileSync(note('doomed'), 'utf8'));
    expect(kept).toMatchObject({ sessionId: 'doomed', title: 'A session', updatedAt: '2026-01-02T03:04:05Z' });
    expect(Date.parse(kept.binnedAt)).toBeGreaterThan(0);
    // In the bin rather than in the session, so restoring puts back what was taken.
    expect(existsSync(join(binned('doomed'), 'binned.json'))).toBe(false);
  });

  it('measures what it is holding', async () => {
    const { binSession } = await load();
    makeSession('doomed', 'twelve chars');

    binSession('doomed', null, null);

    expect(JSON.parse(readFileSync(note('doomed'), 'utf8')).bytes).toBe(12);
  });

  it('says there was nothing to bin when the session has no directory', async () => {
    const { binSession } = await load();

    expect(binSession('never-existed', null, null)).toBe(false);
  });

  // Without a folder to put it in there is no bin, and saying so is what sends the caller
  // back to deleting outright rather than quietly losing the session.
  it('says there was nothing to bin when the app has no folder of its own', async () => {
    delete process.env.COPILOT_DESKTOP_DATA;
    const { binSession } = await load();
    const from = makeSession('doomed');

    expect(binSession('doomed', null, null)).toBe(false);
    expect(existsSync(from)).toBe(true);
  });

  /** The id is the session, so an older copy of it is an older state of the same thing. */
  it('replaces an older copy of the same session', async () => {
    const { binSession } = await load();
    makeSession('doomed', 'first\n');
    // Something the later state does not have, so merging the two would leave it behind.
    writeFileSync(join(home, 'session-state', 'doomed', 'checkpoint-1'), 'gone by then', 'utf8');
    binSession('doomed', null, null);
    makeSession('doomed', 'second\n');

    binSession('doomed', null, null);

    expect(readFileSync(join(binned('doomed'), 'events.jsonl'), 'utf8')).toBe('second\n');
    expect(existsSync(join(binned('doomed'), 'checkpoint-1'))).toBe(false);
  });
});

describe('reading the bin', () => {
  it('is empty before anything is deleted', async () => {
    const { binnedSessions } = await load();

    expect(binnedSessions()).toEqual([]);
  });

  it('lists what was put there', async () => {
    const { binSession, binnedSessions } = await load();
    makeSession('doomed');
    binSession('doomed', 'A session', '2026-01-02T03:04:05Z');

    expect(binnedSessions()).toMatchObject([{ sessionId: 'doomed', title: 'A session' }]);
  });

  it('puts the most recently deleted first', async () => {
    const { binnedSessions } = await load();
    mkdirSync(binned('older'), { recursive: true });
    mkdirSync(binned('newer'), { recursive: true });
    writeFileSync(note('older'), JSON.stringify({ binnedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
    writeFileSync(note('newer'), JSON.stringify({ binnedAt: '2026-02-01T00:00:00.000Z' }), 'utf8');

    expect(binnedSessions().map((session: { sessionId: string }) => session.sessionId)).toEqual(['newer', 'older']);
  });

  /** A move that stopped halfway leaves one without the other, and neither can be restored. */
  it('leaves out a directory with nothing saying what it was', async () => {
    const { binnedSessions } = await load();
    mkdirSync(binned('orphan'), { recursive: true });

    expect(binnedSessions()).toEqual([]);
  });

  it('leaves out a note with no directory behind it', async () => {
    const { binnedSessions } = await load();
    mkdirSync(join(data, 'recycle-bin'), { recursive: true });
    writeFileSync(note('ghost'), JSON.stringify({ binnedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');

    expect(binnedSessions()).toEqual([]);
  });

  it('leaves out a note it cannot read', async () => {
    const { binnedSessions } = await load();
    mkdirSync(binned('broken'), { recursive: true });
    writeFileSync(note('broken'), 'not json at all', 'utf8');

    expect(binnedSessions()).toEqual([]);
  });

  it('leaves out a note that does not say when it was binned', async () => {
    const { binnedSessions } = await load();
    mkdirSync(binned('undated'), { recursive: true });
    writeFileSync(note('undated'), JSON.stringify({ title: 'No date' }), 'utf8');

    expect(binnedSessions()).toEqual([]);
  });
});

describe('restoring a session', () => {
  it('puts it back where the CLI looks for it', async () => {
    const { binSession, restoreSession } = await load();
    makeSession('doomed');
    binSession('doomed', null, null);

    expect(restoreSession('doomed')).toBe(true);

    expect(readFileSync(join(home, 'session-state', 'doomed', 'events.jsonl'), 'utf8')).toBe('hello\n');
  });

  it('takes it out of the bin', async () => {
    const { binSession, restoreSession, binnedSessions } = await load();
    makeSession('doomed');
    binSession('doomed', null, null);

    restoreSession('doomed');

    expect(binnedSessions()).toEqual([]);
    expect(existsSync(note('doomed'))).toBe(false);
  });

  it('says there was nothing to restore', async () => {
    const { restoreSession } = await load();

    expect(restoreSession('never-binned')).toBe(false);
  });

  /** That would be a live session replaced by an older copy of itself. */
  it('refuses when a session of that id is already there', async () => {
    const { binSession, restoreSession } = await load();
    makeSession('doomed', 'old\n');
    binSession('doomed', null, null);
    makeSession('doomed', 'new\n');

    expect(restoreSession('doomed')).toBe(false);

    expect(readFileSync(join(home, 'session-state', 'doomed', 'events.jsonl'), 'utf8')).toBe('new\n');
    expect(existsSync(binned('doomed'))).toBe(true);
  });
});

describe('purging a session', () => {
  it('takes the directory and what it was remembered by', async () => {
    const { binSession, purgeSession } = await load();
    makeSession('doomed');
    binSession('doomed', null, null);

    purgeSession('doomed');

    expect(existsSync(binned('doomed'))).toBe(false);
    expect(existsSync(note('doomed'))).toBe(false);
  });

  it('says nothing about one that is not there', async () => {
    const { purgeSession } = await load();

    expect(() => purgeSession('never-binned')).not.toThrow();
  });
});

describe('sweeping the bin', () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (ms: number) => new Date(ms).toISOString();

  /** Placed by hand, since binning always stamps the present. */
  const put = (sessionId: string, binnedAt: string) => {
    mkdirSync(binned(sessionId), { recursive: true });
    writeFileSync(note(sessionId), JSON.stringify({ binnedAt }), 'utf8');
  };

  it('deletes what has been there longer than it was meant to be', async () => {
    const { sweepBin, binnedSessions } = await load();
    const now = Date.parse('2026-03-01T00:00:00.000Z');
    put('old', at(now - 8 * day));
    put('recent', at(now - 6 * day));

    expect(sweepBin(7, now)).toBe(1);

    expect(binnedSessions().map((session: { sessionId: string }) => session.sessionId)).toEqual(['recent']);
  });

  /**
   * Zero keeps nothing, so a bin under that rule is an empty one. The setting says how long
   * a deleted session is kept, and something kept longer than that is past it however long
   * ago it was put there - so shortening it reaches what is already in the bin.
   */
  it('empties the bin when nothing is to be kept', async () => {
    const { sweepBin, binnedSessions } = await load();
    put('old', at(Date.parse('2020-01-01T00:00:00.000Z')));
    put('binned-just-now', new Date().toISOString());

    expect(sweepBin(0)).toBe(2);

    expect(binnedSessions()).toEqual([]);
  });

  it('applies a shortened retention to what is already there', async () => {
    const { sweepBin, binnedSessions } = await load();
    const now = Date.parse('2026-03-01T00:00:00.000Z');
    put('a-fortnight-old', at(now - 14 * day));
    put('two-days-old', at(now - 2 * day));

    // Kept under the week it was binned with, past it under the three days now asked for.
    expect(sweepBin(3, now)).toBe(1);

    expect(binnedSessions().map((session: { sessionId: string }) => session.sessionId)).toEqual(['two-days-old']);
  });

  it('counts from when it was binned rather than when it was last used', async () => {
    const { sweepBin, binnedSessions } = await load();
    const now = Date.parse('2026-03-01T00:00:00.000Z');
    mkdirSync(binned('stale'), { recursive: true });
    // Untouched for a year, binned this morning: the promise is about the deleting.
    writeFileSync(
      note('stale'),
      JSON.stringify({ binnedAt: at(now - 1000), updatedAt: '2025-03-01T00:00:00.000Z' }),
      'utf8',
    );

    sweepBin(7, now);

    expect(binnedSessions()).toHaveLength(1);
  });

  it('sweeps one that has sat exactly its retention', async () => {
    const { sweepBin } = await load();
    const now = Date.parse('2026-03-01T00:00:00.000Z');
    put('exact', at(now - 7 * day));

    expect(sweepBin(7, now)).toBe(1);
  });
});
