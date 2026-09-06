import { describe, expect, it } from 'vitest';

import { countChanges, parsePatch } from './patch';

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

    // The index line, the mode and the two paths say nothing the row does not already.
    expect(lines.some((line) => line.text.includes('index 1111111'))).toBe(false);
    expect(lines[0]?.kind).toBe('hunk');
  });

  it('labels each line by what it means', () => {
    const kinds = parsePatch(patch).map((line) => line.kind);
    expect(kinds).toEqual(['hunk', 'context', 'removed', 'added', 'added', 'context']);
  });

  it('strips the marker, since the kind carries it', () => {
    const added = parsePatch(patch).find((line) => line.kind === 'added');
    expect(added?.text).toBe('const added = 2;');
  });

  /**
   * Line numbers are the point of showing a patch rather than two blobs of text: they say
   * where in the file to look. Removed lines exist only on the left, added only on the
   * right, and context on both.
   */
  it('numbers the lines on the side they exist', () => {
    const lines = parsePatch(patch);

    expect(lines[1]).toMatchObject({ kind: 'context', before: 10, after: 10 });
    expect(lines[2]).toMatchObject({ kind: 'removed', before: 11, after: null });
    expect(lines[3]).toMatchObject({ kind: 'added', before: null, after: 11 });
    expect(lines[4]).toMatchObject({ kind: 'added', before: null, after: 12 });
    expect(lines[5]).toMatchObject({ kind: 'context', before: 12, after: 13 });
  });

  it('starts counting again at each hunk', () => {
    const two = [
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '@@ -50,2 +60,2 @@',
      ' fifty',
      '+sixty',
    ].join('\n');

    const lines = parsePatch(two);
    expect(lines.find((line) => line.text === 'fifty')).toMatchObject({ before: 50, after: 60 });
    expect(lines.find((line) => line.text === 'sixty')).toMatchObject({ after: 61 });
  });

  // Its absence changes the file but is not itself a line of it.
  it('leaves out the missing newline marker', () => {
    const lines = parsePatch('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file');
    expect(lines.map((line) => line.text)).toEqual(['@@ -1 +1 @@', 'old', 'new']);
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

describe('countChanges', () => {
  it('counts what was added and removed', () => {
    expect(countChanges(parsePatch(patch))).toEqual({ added: 2, removed: 1 });
  });

  it('counts nothing in nothing', () => {
    expect(countChanges([])).toEqual({ added: 0, removed: 0 });
  });
});
