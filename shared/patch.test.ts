import { describe, expect, it } from 'vitest';

import { splitByFile } from './patch.js';

/**
 * The files a patch is about (#140 follow-up).
 *
 * `apply_patch` carries no path in its arguments - the paths are inside the patch - and
 * measured over the 1,273 calls on this machine only two thirds name a single file. A fifth
 * name two and the rest up to eighteen, so a row's single path cannot stand for them.
 *
 * Every shape below is one the logs here actually contain.
 */
describe('splitByFile', () => {
  const modified = [
    'diff --git a/C:/w/a.ts b/C:/w/a.ts',
    'index 0000000..0000000 100644',
    '--- a/C:/w/a.ts',
    '+++ b/C:/w/a.ts',
    '@@ -1,1 +1,1 @@',
    '-one',
    '+two',
  ].join('\n');

  it('finds the file a patch is about', () => {
    expect(splitByFile(modified).map((f) => f.path)).toEqual(['C:/w/a.ts']);
  });

  it('keeps the hunks with the file they belong to', () => {
    expect(splitByFile(modified)[0]?.patch).toContain('+two');
  });

  it('finds every file a patch is about', () => {
    const both = `${modified}\n${modified.replace(/a\.ts/g, 'b.ts')}`;

    expect(splitByFile(both).map((f) => f.path)).toEqual(['C:/w/a.ts', 'C:/w/b.ts']);
  });

  it('gives each file only its own hunks', () => {
    const both = [
      'diff --git a/C:/w/a.ts b/C:/w/a.ts',
      '--- a/C:/w/a.ts',
      '+++ b/C:/w/a.ts',
      '@@ -1,1 +1,1 @@',
      '+from a',
      'diff --git a/C:/w/b.ts b/C:/w/b.ts',
      '--- a/C:/w/b.ts',
      '+++ b/C:/w/b.ts',
      '@@ -1,1 +1,1 @@',
      '+from b',
    ].join('\n');

    const [a, b] = splitByFile(both);
    expect(a?.patch).toContain('+from a');
    expect(a?.patch).not.toContain('+from b');
    expect(b?.patch).toContain('+from b');
  });

  /** A deletion ends at nothing, so the name is the one it had before. */
  it('names a file the patch deletes', () => {
    const deleted = [
      'diff --git a/C:/w/gone.ts b/dev/null',
      '--- a/C:/w/gone.ts',
      '+++ b/dev/null',
      '@@ -1,1 +0,0 @@',
      '-one',
    ].join('\n');

    expect(splitByFile(deleted).map((f) => f.path)).toEqual(['C:/w/gone.ts']);
  });

  /** A creation starts from nothing, so the name is the one it ends with. */
  it('names a file the patch creates', () => {
    const created = [
      'diff --git a/C:/w/new.ts b/C:/w/new.ts',
      'create file mode 100644',
      '--- a/dev/null',
      '+++ b/C:/w/new.ts',
      '@@ -1,0 +1,1 @@',
      '+one',
    ].join('\n');

    expect(splitByFile(created).map((f) => f.path)).toEqual(['C:/w/new.ts']);
  });

  /**
   * The `diff --git` line holds both paths with a space between them, which cannot be split
   * reliably when a path contains one. The `---` and `+++` lines hold one each.
   */
  it('reads a path with a space in it', () => {
    const spaced = [
      'diff --git a/C:/my work/a b.ts b/C:/my work/a b.ts',
      '--- a/C:/my work/a b.ts',
      '+++ b/C:/my work/a b.ts',
      '@@ -1,1 +1,1 @@',
      '+one',
    ].join('\n');

    expect(splitByFile(spaced).map((f) => f.path)).toEqual(['C:/my work/a b.ts']);
  });

  it('finds nothing in something that is not a patch', () => {
    expect(splitByFile('just some output')).toEqual([]);
  });

  it('finds nothing in an empty string', () => {
    expect(splitByFile('')).toEqual([]);
  });

  it('ignores a section naming no file at either end', () => {
    const neither = ['diff --git a/dev/null b/dev/null', '--- a/dev/null', '+++ b/dev/null'].join('\n');

    expect(splitByFile(neither)).toEqual([]);
  });
});

/**
 * What a patch does to each file, and by how much.
 *
 * Read here rather than from the tool's arguments: every successful write reports a diff -
 * 27,303 of them in the logs on this machine, without exception - and the diff is the same
 * shape whichever tool wrote it, where the arguments are not.
 */
describe('what a patch says happened', () => {
  const diff = (...body: string[]) => ['diff --git a/f.ts b/f.ts', ...body].join('\n');

  it('counts the lines added and removed', () => {
    const [file] = splitByFile(diff('--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,3 @@', ' kept', '-gone', '+new', '+more'));

    expect(file?.added).toBe(2);
    expect(file?.removed).toBe(1);
  });

  /** The header's own lines begin with the same characters as a change to the file. */
  it('does not count the header as a change', () => {
    const [file] = splitByFile(diff('--- a/f.ts', '+++ b/f.ts', '@@ -1,1 +1,1 @@', ' kept'));

    expect(file?.added).toBe(0);
    expect(file?.removed).toBe(0);
  });

  it('says a file was modified', () => {
    const [file] = splitByFile(diff('--- a/f.ts', '+++ b/f.ts', '@@ -1,1 +1,1 @@', '-one', '+two'));

    expect(file?.status).toBe('modified');
  });

  it('says a file was created', () => {
    const [file] = splitByFile(diff('--- a/dev/null', '+++ b/f.ts', '@@ -1,0 +1,1 @@', '+one'));

    expect(file?.status).toBe('created');
  });

  it('says a file was deleted', () => {
    const [file] = splitByFile(diff('--- a/f.ts', '+++ b/dev/null', '@@ -1,1 +0,0 @@', '-one'));

    expect(file?.status).toBe('deleted');
  });

  it('counts each file in a patch separately', () => {
    const both = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '+one',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,1 +1,1 @@',
      '-two',
      '-three',
    ].join('\n');

    const files = splitByFile(both);

    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ['a.ts', 1, 0],
      ['b.ts', 0, 2],
    ]);
  });
});
