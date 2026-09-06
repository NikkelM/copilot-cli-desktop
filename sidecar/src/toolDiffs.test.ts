import { describe, expect, it } from 'vitest';

import { recordPatches, reportsChanges, splitPatches, touchedFiles } from './toolDiffs.js';

/** Shaped as the tools actually report it, absolute paths and all. */
const edited = [
  '',
  'diff --git a/C:/Users/nikke/Downloads/notes.txt b/C:/Users/nikke/Downloads/notes.txt',
  'index 0000000..0000000 100644',
  '--- a/C:/Users/nikke/Downloads/notes.txt',
  '+++ b/C:/Users/nikke/Downloads/notes.txt',
  '@@ -1,3 +1,3 @@',
  ' first',
  '-second',
  '+second, revised',
  ' third',
].join('\n');

const created = [
  'diff --git a/C:/tmp/new.txt b/C:/tmp/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/C:/tmp/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
].join('\n');

describe('splitPatches', () => {
  /**
   * The reason this exists. A file outside any repository is reported exactly as one
   * inside it, so auditing an agent does not depend on where it was working.
   */
  it('reads a change to a file that is in no repository', () => {
    const [patch] = splitPatches(edited);

    expect(patch?.path).toBe('C:\\Users\\nikke\\Downloads\\notes.txt');
    expect(patch?.status).toBe('modified');
    expect(patch?.patch).toContain('+second, revised');
  });

  it('separates the files of one call that touched several', () => {
    const both = splitPatches(`${edited}\n${created}`);

    expect(both.map((p) => p.path)).toEqual(['C:\\Users\\nikke\\Downloads\\notes.txt', 'C:\\tmp\\new.txt']);
    expect(both.map((p) => p.status)).toEqual(['modified', 'added']);
  });

  it('knows a file that was created', () => {
    expect(splitPatches(created)[0]?.status).toBe('added');
  });

  it('knows a file that was deleted', () => {
    const deleted = ['diff --git a/C:/tmp/gone.txt b/C:/tmp/gone.txt', 'deleted file mode 100644'].join('\n');
    expect(splitPatches(deleted)[0]?.status).toBe('deleted');
  });

  it('takes the name a rename ended at', () => {
    const renamed = 'diff --git a/C:/tmp/old.txt b/C:/tmp/new.txt\nsimilarity index 100%';
    expect(splitPatches(renamed)[0]?.path).toBe('C:\\tmp\\new.txt');
  });

  // A shell command reports its output, not a patch, and must not be mistaken for one.
  it('finds nothing in output that is not a diff', () => {
    expect(splitPatches('C:\\Users\\nikke\\notes.txt\n<shellId: 0 completed with exit code 0>')).toEqual([]);
    expect(splitPatches('')).toEqual([]);
  });
});

describe('reportsChanges', () => {
  it('knows which tools account for their own work', () => {
    expect(reportsChanges('edit')).toBe(true);
    expect(reportsChanges('create')).toBe(true);
    expect(reportsChanges('apply_patch')).toBe(true);
  });

  // Shell writes are covered by the repository snapshot, where there is one.
  it('does not expect a shell command to', () => {
    expect(reportsChanges('powershell')).toBe(false);
    expect(reportsChanges(null)).toBe(false);
  });
});

describe('what a session touched', () => {
  const patch = (path: string, status: 'added' | 'modified' | 'deleted') => ({ path, status, patch: '' });

  it('keeps each account rather than collapsing them', () => {
    const first = recordPatches([], [patch('a.txt', 'modified')]);
    const second = recordPatches(first, [patch('a.txt', 'modified')]);

    // Undoing requires each step, so three edits to one file are three records.
    expect(second).toHaveLength(2);
  });

  it('reports a file once, however often it was written', () => {
    const patches = [patch('a.txt', 'modified'), patch('a.txt', 'modified'), patch('b.txt', 'added')];
    expect(touchedFiles(patches)).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'added' },
    ]);
  });

  it('calls a file the agent made and then edited created', () => {
    expect(touchedFiles([patch('a.txt', 'added'), patch('a.txt', 'modified')])).toEqual([
      { path: 'a.txt', status: 'added' },
    ]);
  });

  it('calls a file deleted last deleted, whatever came before', () => {
    expect(touchedFiles([patch('a.txt', 'modified'), patch('a.txt', 'deleted')])).toEqual([
      { path: 'a.txt', status: 'deleted' },
    ]);
  });

  it('calls a file deleted and then written again modified', () => {
    expect(touchedFiles([patch('a.txt', 'deleted'), patch('a.txt', 'added')])).toEqual([
      { path: 'a.txt', status: 'modified' },
    ]);
  });
});
