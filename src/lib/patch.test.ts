import { describe, expect, it } from 'vitest';

import { countChanges, parsePatch, splitByFile } from './patch';

const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,5 @@ function thing() {',
  ' const before = 1;',
  '-const gone = 2;',
  '+const added = 2;',
  '+const alsoAdded = 3;',
  ' const after = 4;',
].join('\n');

describe('parsePatch', () => {
  it('keeps only the change, not git explaining how it got there', () => {
    const lines = parsePatch(patch);
    expect(lines.some((line) => line.text.includes('index 1111111'))).toBe(false);
    expect(lines[0]?.kind).toBe('context');
  });

  it('labels each line by what it means', () => {
    expect(parsePatch(patch).map((line) => line.kind)).toEqual(['context', 'removed', 'added', 'added', 'context']);
  });

  it('strips the marker, since the kind carries it', () => {
    expect(parsePatch(patch).find((line) => line.kind === 'added')?.text).toBe('const added = 2;');
  });

  /**
   * Line numbers are the point of showing a patch rather than two blobs of text: they say
   * where in the file to look. Removed lines exist only on the left, added only on the
   * right, and context on both.
   */
  it('numbers the lines on the side they exist', () => {
    const lines = parsePatch(patch);

    expect(lines[0]).toMatchObject({ kind: 'context', before: 10, after: 10 });
    expect(lines[1]).toMatchObject({ kind: 'removed', before: 11, after: null });
    expect(lines[2]).toMatchObject({ kind: 'added', before: null, after: 11 });
    expect(lines[3]).toMatchObject({ kind: 'added', before: null, after: 12 });
    expect(lines[4]).toMatchObject({ kind: 'context', before: 12, after: 13 });
  });

  it('starts counting again at each hunk', () => {
    const two = ['@@ -1,2 +1,2 @@', ' one', '-two', '@@ -50,2 +60,2 @@', ' fifty', '+sixty'].join('\n');

    const lines = parsePatch(two);
    expect(lines.find((line) => line.text === 'fifty')).toMatchObject({ before: 50, after: 60 });
    expect(lines.find((line) => line.text === 'sixty')).toMatchObject({ after: 61 });
  });

  it('marks a hunk boundary as ground it stepped over', () => {
    const two = ['@@ -1,1 +1,1 @@', '-one', '@@ -50,1 +50,1 @@', '+fifty'].join('\n');
    expect(parsePatch(two).map((line) => line.kind)).toEqual(['removed', 'skip', 'added']);
  });

  // Its absence changes the file but is not itself a line of it.
  it('leaves out the missing newline marker', () => {
    const lines = parsePatch('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file');
    expect(lines.map((line) => line.text)).toEqual(['old', 'new']);
  });

  it('finds nothing in something that is not a patch', () => {
    expect(parsePatch('')).toEqual([]);
    expect(parsePatch('just some output')).toEqual([]);
  });

  it('reads a new file as all additions', () => {
    const created = ['diff --git a/new.txt b/new.txt', 'new file mode 100644', '@@ -0,0 +1,2 @@', '+one', '+two'].join(
      '\n',
    );
    expect(parsePatch(created).filter((line) => line.kind === 'added')).toHaveLength(2);
  });
});

/**
 * A line reported as changed is usually mostly unchanged. Colouring all of it says only
 * that something happened somewhere in it, which is what the reader already knew.
 */
describe('what within a line changed', () => {
  const changed = (from: string, to: string) => parsePatch(`@@ -1,1 +1,1 @@\n-${from}\n+${to}`);

  it('marks only the part that differs', () => {
    const [removed, added] = changed('const total = count(a);', 'const total = count(b);');

    expect(removed?.segments?.filter((s) => s.changed).map((s) => s.text)).toEqual(['a']);
    expect(added?.segments?.filter((s) => s.changed).map((s) => s.text)).toEqual(['b']);
  });

  it('keeps the whole line readable around the marked part', () => {
    const [, added] = changed('let x = 1;', 'let x = 2;');
    expect(added?.segments?.map((s) => s.text).join('')).toBe('let x = 2;');
  });

  it('marks a changed beginning', () => {
    const [, added] = changed('  indented', '    indented');
    expect(added?.segments?.filter((s) => s.changed).map((s) => s.text)).toEqual(['  ']);
  });

  // Marking part of it would claim a similarity that is not there.
  it('marks nothing when the lines have nothing in common', () => {
    const [removed, added] = changed('one', 'two');
    expect(removed?.segments).toBeUndefined();
    expect(added?.segments).toBeUndefined();
  });

  // A shared closing bracket or semicolon is worth keeping out of the marked part.
  it('treats a shared ending as common however short it is', () => {
    const [, added] = changed('foo(a);', 'bar(b);');
    expect(added?.segments?.filter((s) => s.changed).map((s) => s.text)).toEqual(['bar(b']);
  });

  it('pairs lines by their place in the run', () => {
    const lines = parsePatch(['@@ -1,2 +1,2 @@', '-one a', '-two a', '+one b', '+two b'].join('\n'));
    const marked = lines.filter((l) => l.kind === 'added').map((l) => l.segments?.find((s) => s.changed)?.text);
    expect(marked).toEqual(['b', 'b']);
  });

  it('leaves a line with no counterpart whole', () => {
    const lines = parsePatch(['@@ -1,1 +1,2 @@', '-one a', '+one b', '+entirely new'].join('\n'));
    expect(lines[2]?.segments).toBeUndefined();
  });
});

/**
 * A patch with generous context can carry dozens of untouched lines between two changes,
 * and scrolling past them to reach the next one is what a diff exists to save you from.
 */
describe('skipping unchanged ground', () => {
  const withContext = (count: number) =>
    ['@@ -1,20 +1,20 @@', '-changed', ...Array.from({ length: count }, (_, i) => ` line ${i}`), '+changed'].join('\n');

  it('leaves a short run alone', () => {
    expect(parsePatch(withContext(5)).filter((line) => line.kind === 'skip')).toHaveLength(0);
  });

  it('replaces a long run with a gap', () => {
    const lines = parsePatch(withContext(30));
    const skip = lines.find((line) => line.kind === 'skip');

    expect(skip).toBeDefined();
    expect(skip?.hidden).toBe(24);
  });

  it('keeps a few lines either side, so a change keeps its surroundings', () => {
    const lines = parsePatch(withContext(30));
    expect(lines.filter((line) => line.kind === 'context')).toHaveLength(6);
  });

  it('says how many lines it stepped over', () => {
    const lines = parsePatch(withContext(30));
    const kept = lines.filter((l) => l.kind === 'context').length;
    const hidden = lines.find((l) => l.kind === 'skip')?.hidden ?? 0;
    expect(kept + hidden).toBe(30);
  });
});

describe('the phantom line at the end of a patch', () => {
  /**
   * Taken verbatim from a real `edit` tool call. A file ending in a newline splits into one
   * more piece than it has lines, and the CLI's patch generator keeps that empty piece - so
   * editing a two-line file claims three, with a final context line containing nothing.
   */
  const asTheCliWroteIt = ['@@ -1,2 +1,3 @@', ' test', '+second line', ' ', ''].join('\n');

  it('does not show a line the file does not have', () => {
    const lines = parsePatch(asTheCliWroteIt);
    expect(lines.map((line) => line.text)).toEqual(['test', 'second line']);
  });

  it('leaves the last real line numbered as it is', () => {
    const lines = parsePatch(asTheCliWroteIt);
    expect(lines[lines.length - 1]?.after).toBe(2);
  });

  // A file that genuinely ends in a blank line produces two empty context lines, and only
  // the artefact should go.
  it('keeps a blank line the file really has', () => {
    const patch = ['@@ -1,3 +1,4 @@', ' test', '+second line', ' ', ' ', ''].join('\n');
    expect(parsePatch(patch).map((line) => line.text)).toEqual(['test', 'second line', '']);
  });

  it('leaves a patch that ends on a change alone', () => {
    const patch = ['@@ -1,1 +1,2 @@', ' test', '+second line', ''].join('\n');
    expect(parsePatch(patch).map((line) => line.text)).toEqual(['test', 'second line']);
  });
});

describe('countChanges', () => {
  it('counts what was added and removed', () => {
    expect(countChanges(parsePatch(patch))).toEqual({ added: 2, removed: 1 });
  });

  it('counts nothing in nothing', () => {
    expect(countChanges([])).toEqual({ added: 0, removed: 0 });
  });
});

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
