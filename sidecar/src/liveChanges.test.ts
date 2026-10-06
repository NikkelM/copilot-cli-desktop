import { beforeEach, describe, expect, it } from 'vitest';

import { forgetLive, hasLive, liveChanges, livePatches, noteToolEnd, noteToolStart } from './liveChanges.js';

const AT = '2026-10-05T14:00:00.000Z';
const SESSION = 's1';

beforeEach(() => {
  forgetLive(SESSION);
  forgetLive('other');
});

/** A diff as a file tool reports one, which is where everything here is read from. */
const diff = (path: string, body: string[], ends: { from?: string; to?: string } = {}) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- ${ends.from ?? `a/${path}`}`,
    `+++ ${ends.to ?? `b/${path}`}`,
    '@@ -1,1 +1,1 @@',
    ...body,
  ].join('\n');

/** Start and finish a write in one go, which is what the runtime does either side of a tool. */
function wrote(patch: string | undefined, over: { id?: string; tool?: string; success?: boolean; at?: string } = {}) {
  const id = over.id ?? 't1';
  noteToolStart(SESSION, id, over.tool ?? 'edit');
  return noteToolEnd(SESSION, id, over.success ?? true, patch, over.at ?? AT);
}

/**
 * What a running turn has touched (#140).
 *
 * Read from the diff every write reports rather than from the tool's arguments. That is the
 * only thing that works for all three writing tools - `edit` and `create` name their file
 * in an argument, `apply_patch` is handed one string and names its files inside it - and it
 * is also where the change itself is, so the panel can draw it before the turn ends.
 */
describe('what a running turn has touched', () => {
  it('knows nothing before a tool has run', () => {
    expect(liveChanges(SESSION)).toEqual([]);
    expect(hasLive(SESSION)).toBe(false);
  });

  it('records what a write reported', () => {
    wrote(diff('a.ts', ['-one', '+two']));

    expect(liveChanges(SESSION)).toEqual([
      {
        path: 'a.ts',
        status: 'modified',
        linesAdded: 1,
        linesRemoved: 1,
        turns: 1,
        changedAt: AT,
        diffable: true,
        running: true,
      },
    ]);
  });

  it('records a file the turn made', () => {
    wrote(diff('new.ts', ['+one', '+two'], { from: 'a/dev/null' }), { tool: 'create' });

    const [row] = liveChanges(SESSION);
    expect(row?.status).toBe('created');
    expect(row?.linesAdded).toBe(2);
  });

  it('records a file the turn removed', () => {
    wrote(diff('gone.ts', ['-one'], { to: 'b/dev/null' }), { tool: 'apply_patch' });

    expect(liveChanges(SESSION)[0]?.status).toBe('deleted');
  });

  it('records every file one write touched', () => {
    wrote(`${diff('a.ts', ['+one'])}\n${diff('b.ts', ['+two'])}`, { tool: 'apply_patch' });

    expect(liveChanges(SESSION).map((c) => c.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('says it is still going, so the count does not read as final', () => {
    wrote(diff('a.ts', ['+one']));

    expect(liveChanges(SESSION)[0]?.running).toBe(true);
  });

  /** The diff is in hand, so the row opens onto it rather than onto an explanation. */
  it('offers the change itself', () => {
    wrote(diff('a.ts', ['+one']));

    expect(liveChanges(SESSION)[0]?.diffable).toBe(true);
    expect(livePatches(SESSION, 'a.ts')).toHaveLength(1);
  });

  it('keeps one session apart from another', () => {
    noteToolStart('other', 't9', 'edit');
    noteToolEnd('other', 't9', true, diff('theirs.ts', ['+one']), AT);

    expect(liveChanges(SESSION)).toEqual([]);
    expect(liveChanges('other')).toHaveLength(1);
  });
});

describe('what it refuses to record', () => {
  it('ignores a tool that does not write files', () => {
    expect(wrote(diff('a.ts', ['+one']), { tool: 'view' })).toBe(false);
    expect(liveChanges(SESSION)).toEqual([]);
  });

  it('ignores a shell command, which it cannot know the effect of', () => {
    expect(wrote(undefined, { tool: 'powershell' })).toBe(false);
  });

  /** A failed write left the file as it was, whatever it meant to do. */
  it('ignores a write that failed', () => {
    expect(wrote(diff('a.ts', ['+one']), { success: false })).toBe(false);
    expect(liveChanges(SESSION)).toEqual([]);
  });

  it('ignores a write that reported no diff', () => {
    expect(wrote(undefined)).toBe(false);
  });

  it('ignores a report that is not a patch', () => {
    expect(wrote('File updated')).toBe(false);
  });

  /** Writing a file without changing it reports a patch of nothing but context. */
  it('ignores a write that moved no lines', () => {
    expect(wrote(diff('a.ts', [' same']))).toBe(false);
    expect(liveChanges(SESSION)).toEqual([]);
  });

  it('ignores a call that finished without ever starting', () => {
    expect(noteToolEnd(SESSION, 'never-started', true, diff('a.ts', ['+one']), AT)).toBe(false);
  });

  /** Counting at the start would show work that never happened and then take it back. */
  it('counts nothing until the call finishes', () => {
    noteToolStart(SESSION, 't1', 'edit');

    expect(liveChanges(SESSION)).toEqual([]);
  });

  it('says nothing about a file nothing has written', () => {
    expect(livePatches(SESSION, 'untouched.ts')).toBeNull();
  });
});

describe('a file touched more than once in the same turn', () => {
  it('is one row, not two', () => {
    wrote(diff('a.ts', ['+one']), { id: 't1' });
    wrote(diff('a.ts', ['+two']), { id: 't2' });

    expect(liveChanges(SESSION)).toHaveLength(1);
  });

  it('adds up what the writes did', () => {
    wrote(diff('a.ts', ['+one']), { id: 't1' });
    wrote(diff('a.ts', ['+two', '-three']), { id: 't2' });

    expect(liveChanges(SESSION)[0]?.linesAdded).toBe(2);
    expect(liveChanges(SESSION)[0]?.linesRemoved).toBe(1);
  });

  /** Kept apart, because the second write numbers the file as the first one left it. */
  it('keeps each write, for the app to join when it draws them', () => {
    wrote(diff('a.ts', ['+one']), { id: 't1' });
    wrote(diff('a.ts', ['+two']), { id: 't2' });

    expect(livePatches(SESSION, 'a.ts')).toHaveLength(2);
  });

  /** Each file gets its own hunks, on the second write as on the first. */
  it('gives a file only its own part of a write that touched several', () => {
    wrote(`${diff('a.ts', ['+one'])}\n${diff('b.ts', ['+two'])}`, { id: 't1', tool: 'apply_patch' });
    wrote(`${diff('a.ts', ['+three'])}\n${diff('b.ts', ['+four'])}`, { id: 't2', tool: 'apply_patch' });

    const held = livePatches(SESSION, 'a.ts') ?? [];

    expect(held).toHaveLength(2);
    expect(held.join('\n')).not.toContain('b.ts');
    expect(held.join('\n')).not.toContain('+four');
  });

  it('takes the time of the latest write', () => {
    wrote(diff('a.ts', ['+one']), { id: 't1', at: AT });
    wrote(diff('a.ts', ['+two']), { id: 't2', at: '2026-10-05T15:00:00.000Z' });

    expect(liveChanges(SESSION)[0]?.changedAt).toBe('2026-10-05T15:00:00.000Z');
  });

  /** A file this turn created is still a file it created, however often it rewrote it. */
  it('stays created when the turn made it and then edited it', () => {
    wrote(diff('new.ts', ['+one'], { from: 'a/dev/null' }), { id: 't1', tool: 'create' });
    wrote(diff('new.ts', ['+two']), { id: 't2' });

    expect(liveChanges(SESSION)[0]?.status).toBe('created');
  });

  it('becomes deleted when the turn made it and then removed it', () => {
    wrote(diff('new.ts', ['+one'], { from: 'a/dev/null' }), { id: 't1', tool: 'create' });
    wrote(diff('new.ts', ['-one'], { to: 'b/dev/null' }), { id: 't2', tool: 'apply_patch' });

    expect(liveChanges(SESSION)[0]?.status).toBe('deleted');
  });
});

/**
 * The store becomes the record when the session goes idle. Keeping this past that moment
 * would count every one of these changes twice.
 */
describe('handing over to the store', () => {
  it('forgets what the turn did', () => {
    wrote(diff('a.ts', ['+one']));

    forgetLive(SESSION);

    expect(liveChanges(SESSION)).toEqual([]);
    expect(hasLive(SESSION)).toBe(false);
  });

  it('forgets the writes it was holding for the panel', () => {
    wrote(diff('a.ts', ['+one']));

    forgetLive(SESSION);

    expect(livePatches(SESSION, 'a.ts')).toBeNull();
  });

  it('forgets a call that never finished, so it cannot land in the next turn', () => {
    noteToolStart(SESSION, 't1', 'edit');

    forgetLive(SESSION);

    expect(noteToolEnd(SESSION, 't1', true, diff('a.ts', ['+one']), AT)).toBe(false);
  });

  it('leaves other sessions alone', () => {
    noteToolStart('other', 't9', 'edit');
    noteToolEnd('other', 't9', true, diff('theirs.ts', ['+one']), AT);

    forgetLive(SESSION);

    expect(liveChanges('other')).toHaveLength(1);
  });
});

/**
 * The caller notifies on a true answer, so saying yes for a read would mean re-reading the
 * whole store for every grep the agent runs.
 */
describe('whether anybody needs telling', () => {
  it('says so when a file moved', () => {
    expect(wrote(diff('a.ts', ['+one']))).toBe(true);
  });

  it('says nothing for a tool that reads', () => {
    expect(wrote(undefined, { tool: 'grep' })).toBe(false);
  });

  it('says so when one file of several moved', () => {
    expect(wrote(`${diff('a.ts', [' same'])}\n${diff('b.ts', ['+one'])}`, { tool: 'apply_patch' })).toBe(true);
  });
});
