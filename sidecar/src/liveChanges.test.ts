import { beforeEach, describe, expect, it } from 'vitest';

import { forgetLive, hasLive, liveChanges, noteToolEnd, noteToolStart } from './liveChanges.js';

const AT = '2026-10-05T14:00:00.000Z';
const SESSION = 's1';

beforeEach(() => {
  forgetLive(SESSION);
  forgetLive('other');
});

/** Start and finish a call in one go, which is what the runtime does either side of a tool. */
function ran(toolName: string, args: unknown, over: { id?: string; success?: boolean; at?: string } = {}): boolean {
  const id = over.id ?? 't1';
  noteToolStart(SESSION, id, toolName, args);
  return noteToolEnd(SESSION, id, over.success ?? true, over.at ?? AT);
}

/**
 * What a turn has changed while it is still running (#140).
 *
 * Every argument shape below is one the logs on this machine actually contain. The tools
 * that write are `edit` (23,820 calls), `create` (3,001) and `apply_patch` (1,242).
 */
describe('what a running turn has touched', () => {
  it('knows nothing before a tool has run', () => {
    expect(liveChanges(SESSION)).toEqual([]);
    expect(hasLive(SESSION)).toBe(false);
  });

  it('records a file an edit changed', () => {
    ran('edit', { path: 'a.ts', old_str: 'one\n', new_str: 'two\n' });

    expect(liveChanges(SESSION)).toEqual([
      {
        path: 'a.ts',
        status: 'modified',
        linesAdded: 1,
        linesRemoved: 1,
        turns: 1,
        changedAt: AT,
        diffable: false,
        running: true,
      },
    ]);
  });

  it('records a file a create made', () => {
    ran('create', { path: 'new.ts', file_text: 'one\ntwo\nthree\n' });

    const [row] = liveChanges(SESSION);
    expect(row?.status).toBe('created');
    expect(row?.linesAdded).toBe(3);
    expect(row?.linesRemoved).toBe(0);
  });

  it('says it is still going, so the count does not read as final', () => {
    ran('edit', { path: 'a.ts', old_str: 'one', new_str: 'two' });

    expect(liveChanges(SESSION)[0]?.running).toBe(true);
  });

  /** There is no snapshot yet, so there is nothing to diff against. */
  it('offers no diff', () => {
    ran('edit', { path: 'a.ts', old_str: 'one', new_str: 'two' });

    expect(liveChanges(SESSION)[0]?.diffable).toBe(false);
  });

  it('keeps one session apart from another', () => {
    noteToolStart('other', 't9', 'edit', { path: 'theirs.ts', old_str: 'a', new_str: 'b' });
    noteToolEnd('other', 't9', true, AT);

    expect(liveChanges(SESSION)).toEqual([]);
    expect(liveChanges('other')).toHaveLength(1);
  });
});

describe('what it refuses to record', () => {
  it('ignores a tool that does not write files', () => {
    expect(ran('view', { path: 'a.ts' })).toBe(false);
    expect(liveChanges(SESSION)).toEqual([]);
  });

  it('ignores a shell command, which it cannot know the effect of', () => {
    ran('powershell', { command: 'Set-Content a.ts x' });

    expect(liveChanges(SESSION)).toEqual([]);
  });

  /** A failed write left the file as it was, whatever it meant to do. */
  it('ignores a write that failed', () => {
    expect(ran('edit', { path: 'a.ts', old_str: 'one', new_str: 'two' }, { success: false })).toBe(false);
    expect(liveChanges(SESSION)).toEqual([]);
  });

  /** 46 of the 23,820 edits in the logs here name no path at all. */
  it('ignores a malformed call that names no file', () => {
    expect(ran('edit', { old_str: 'one', new_str: 'two' })).toBe(false);
    expect(liveChanges(SESSION)).toEqual([]);
  });

  it('ignores arguments that are not an object at all', () => {
    expect(ran('edit', null)).toBe(false);
  });

  it('ignores a call that finished without ever starting', () => {
    expect(noteToolEnd(SESSION, 'never-started', true, AT)).toBe(false);
  });

  /** Counting at the start would show work that never happened and then take it back. */
  it('counts nothing until the call finishes', () => {
    noteToolStart(SESSION, 't1', 'edit', { path: 'a.ts', old_str: 'one', new_str: 'two' });

    expect(liveChanges(SESSION)).toEqual([]);
  });
});

/**
 * Counted through the same differ the panel uses. Not the lengths of the two strings:
 * replacing one line of twenty with another is one added and one removed.
 */
describe('counting what an edit did', () => {
  const counts = (old_str: string, new_str: string) => {
    forgetLive(SESSION);
    ran('edit', { path: 'a.ts', old_str, new_str });
    const [row] = liveChanges(SESSION);
    return { added: row?.linesAdded, removed: row?.linesRemoved };
  };

  it('counts a line swapped for another as one each way', () => {
    expect(counts('one\n', 'two\n')).toEqual({ added: 1, removed: 1 });
  });

  it('counts lines added to the end of a block', () => {
    expect(counts('one\n', 'one\ntwo\nthree\n')).toEqual({ added: 2, removed: 0 });
  });

  it('counts lines taken out', () => {
    expect(counts('one\ntwo\nthree\n', 'one\n')).toEqual({ added: 0, removed: 2 });
  });

  it('records nothing for a replacement that changed nothing', () => {
    expect(counts('one\n', 'one\n')).toEqual({ added: undefined, removed: undefined });
  });

  /** An empty file is still a file that was made, so a create is recorded either way. */
  it('still records a file created empty', () => {
    forgetLive(SESSION);
    ran('create', { path: 'empty.ts', file_text: '' });

    expect(liveChanges(SESSION)[0]?.status).toBe('created');
  });

  it('does not mistake the length of the block for what moved in it', () => {
    const many = Array.from({ length: 20 }, (_, n) => `line ${n}`).join('\n');
    const one = many.replace('line 7', 'line seven');

    expect(counts(many, one)).toEqual({ added: 1, removed: 1 });
  });
});

/**
 * A patch envelope is the CLI's own format rather than a unified diff, and one call may
 * name several files. Measured here: 2,144 updates, 89 additions and 14 deletions.
 */
describe('counting what a patch did', () => {
  const patch = (body: string) => {
    forgetLive(SESSION);
    ran('apply_patch', body);
    return liveChanges(SESSION);
  };

  it('records the file an update names', () => {
    const [row] = patch('*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch\n');

    expect(row?.path).toBe('a.ts');
    expect(row?.status).toBe('modified');
    expect(row?.linesAdded).toBe(1);
    expect(row?.linesRemoved).toBe(1);
  });

  it('records every file one patch names', () => {
    const rows = patch(
      '*** Begin Patch\n*** Update File: a.ts\n@@\n-one\n+two\n*** Update File: b.ts\n@@\n+added\n*** End Patch\n',
    );

    expect(rows.map((r) => r.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('counts each file separately', () => {
    const rows = patch(
      '*** Begin Patch\n*** Update File: a.ts\n@@\n-one\n+two\n*** Update File: b.ts\n@@\n+added\n+more\n*** End Patch\n',
    );

    expect(rows.find((r) => r.path === 'b.ts')?.linesAdded).toBe(2);
    expect(rows.find((r) => r.path === 'b.ts')?.linesRemoved).toBe(0);
  });

  it('says a file was made when the patch adds one', () => {
    const [row] = patch('*** Begin Patch\n*** Add File: new.ts\n+one\n+two\n*** End Patch\n');

    expect(row?.status).toBe('created');
    expect(row?.linesAdded).toBe(2);
  });

  it('says a file went when the patch deletes one', () => {
    const [row] = patch('*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch\n');

    expect(row?.status).toBe('deleted');
  });

  /** A move is the same change seen from the other end, not a file of its own. */
  it('follows a file that moved rather than counting it twice', () => {
    const rows = patch('*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-one\n+two\n*** End Patch\n');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe('new.ts');
  });

  it('does not read the envelope markers as removed lines', () => {
    const [row] = patch('*** Begin Patch\n*** Update File: a.ts\n@@\n+one\n*** End Patch\n');

    expect(row?.linesRemoved).toBe(0);
  });

  it('records nothing for a patch naming no files', () => {
    expect(patch('*** Begin Patch\n*** End Patch\n')).toEqual([]);
  });

  it('records nothing when the arguments are an object rather than a patch', () => {
    forgetLive(SESSION);
    ran('apply_patch', { path: 'a.ts' });

    expect(liveChanges(SESSION)).toEqual([]);
  });
});

describe('a file touched more than once in the same turn', () => {
  it('is one row, not two', () => {
    ran('edit', { path: 'a.ts', old_str: 'one\n', new_str: 'two\n' }, { id: 't1' });
    ran('edit', { path: 'a.ts', old_str: 'two\n', new_str: 'three\n' }, { id: 't2' });

    expect(liveChanges(SESSION)).toHaveLength(1);
  });

  it('adds up what the writes did', () => {
    ran('edit', { path: 'a.ts', old_str: 'one\n', new_str: 'two\n' }, { id: 't1' });
    ran('edit', { path: 'a.ts', old_str: 'two\n', new_str: 'three\nfour\n' }, { id: 't2' });

    expect(liveChanges(SESSION)[0]?.linesAdded).toBe(3);
  });

  it('takes the time of the latest write', () => {
    ran('edit', { path: 'a.ts', old_str: 'one', new_str: 'two' }, { id: 't1', at: AT });
    ran('edit', { path: 'a.ts', old_str: 'two', new_str: 'three' }, { id: 't2', at: '2026-10-05T15:00:00.000Z' });

    expect(liveChanges(SESSION)[0]?.changedAt).toBe('2026-10-05T15:00:00.000Z');
  });

  /** A file this turn created is still a file it created, however often it rewrote it. */
  it('stays created when the turn made it and then edited it', () => {
    ran('create', { path: 'new.ts', file_text: 'one\n' }, { id: 't1' });
    ran('edit', { path: 'new.ts', old_str: 'one\n', new_str: 'two\n' }, { id: 't2' });

    expect(liveChanges(SESSION)[0]?.status).toBe('created');
  });

  it('becomes deleted when the turn made it and then removed it', () => {
    ran('create', { path: 'new.ts', file_text: 'one\n' }, { id: 't1' });
    ran('apply_patch', '*** Begin Patch\n*** Delete File: new.ts\n*** End Patch\n', { id: 't2' });

    expect(liveChanges(SESSION)[0]?.status).toBe('deleted');
  });
});

/**
 * The store becomes the record when the session goes idle. Keeping this past that moment
 * would count every one of these changes twice.
 */
describe('handing over to the store', () => {
  it('forgets what the turn did', () => {
    ran('edit', { path: 'a.ts', old_str: 'one', new_str: 'two' });

    forgetLive(SESSION);

    expect(liveChanges(SESSION)).toEqual([]);
    expect(hasLive(SESSION)).toBe(false);
  });

  it('forgets a call that never finished, so it cannot land in the next turn', () => {
    noteToolStart(SESSION, 't1', 'edit', { path: 'a.ts', old_str: 'one', new_str: 'two' });

    forgetLive(SESSION);

    expect(noteToolEnd(SESSION, 't1', true, AT)).toBe(false);
  });

  it('leaves other sessions alone', () => {
    noteToolStart('other', 't9', 'edit', { path: 'theirs.ts', old_str: 'a', new_str: 'b' });
    noteToolEnd('other', 't9', true, AT);

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
    expect(ran('create', { path: 'a.ts', file_text: 'x\n' })).toBe(true);
  });

  it('says nothing for a tool that reads', () => {
    expect(ran('grep', { pattern: 'x' })).toBe(false);
  });

  it('says nothing for a write that moved no lines', () => {
    expect(ran('edit', { path: 'a.ts', old_str: 'same\n', new_str: 'same\n' })).toBe(false);
  });
});
