import { describe, expect, it } from 'vitest';

import { changesByTurn } from './turnChanges';
import type { Entry } from './transcriptEntries';

/** A patch of the given shape, which is all `countChanges` reads. */
const patch = (added: number, removed: number) =>
  [
    'diff --git a/x b/x',
    '@@ -1,1 +1,1 @@',
    ...Array.from({ length: added }, (_, index) => `+line ${index}`),
    ...Array.from({ length: removed }, (_, index) => `-line ${index}`),
  ].join('\n');

const asked = (key: string): Entry => ({ kind: 'message', key, variant: 'user', body: 'do it' });
const said = (key: string): Entry => ({ kind: 'message', key, variant: 'assistant', body: 'done' });

const edited = (key: string, path: string, added: number, removed: number): Entry =>
  ({
    kind: 'tool',
    key,
    name: 'str_replace_editor',
    summary: path,
    output: null,
    status: 'ok',
    path,
    patch: patch(added, removed),
  }) as Entry;

const ran = (key: string): Entry =>
  ({ kind: 'tool', key, name: 'shell', summary: 'ls', output: 'x', status: 'ok' }) as Entry;

describe('what a turn changed', () => {
  it('gathers a turn at the row it ends on', () => {
    const entries = [asked('a'), edited('b', 'one.ts', 3, 1), edited('c', 'two.ts', 2, 0), said('d')];

    const byTurn = changesByTurn(entries);

    expect([...byTurn.keys()], 'the last row of the turn').toEqual([3]);
    expect(byTurn.get(3)).toEqual({
      files: [
        { path: 'one.ts', added: 3, removed: 1, patches: [patch(3, 1)] },
        { path: 'two.ts', added: 2, removed: 0, patches: [patch(2, 0)] },
      ],
      added: 5,
      removed: 1,
    });
  });

  // A file is often written more than once in a turn, and it is one file either way.
  it('counts a file once, however many times it was written', () => {
    const entries = [asked('a'), edited('b', 'one.ts', 3, 1), edited('c', 'one.ts', 4, 2), said('d')];

    const only = changesByTurn(entries).get(3);

    expect(only?.files).toEqual([
      { path: 'one.ts', added: 7, removed: 3, patches: [patch(3, 1), patch(4, 2)] },
    ]);
    expect(only?.added).toBe(7);
  });

  /** Its own row says the same thing, for a reader who asked not to be told twice. */
  it('says nothing about a turn with one edit in it, when only several are wanted', () => {
    const entries = [asked('a'), edited('b', 'one.ts', 3, 1), said('c')];

    expect(changesByTurn(entries, 'multiple').size).toBe(0);
  });

  it('says nothing about a turn that changed nothing', () => {
    const entries = [asked('a'), ran('b'), ran('c'), said('d')];

    expect(changesByTurn(entries).size).toBe(0);
  });

  /**
   * A file written back unchanged leaves a patch of nothing but context. It is not an edit,
   * and drawing it produces a diff with nothing in it.
   */
  it('does not count writing a file without changing it', () => {
    const entries = [asked('a'), edited('b', 'one.ts', 2, 0), edited('c', 'one.ts', 0, 0), said('d')];

    const only = changesByTurn(entries, 'multiple').get(3);

    expect(only).toBeUndefined();
  });

  /** The reader's choice, since a lone edit's own row already answers it (#40). */
  describe('when a turn is worth a line of its own', () => {
    const one = [asked('a'), edited('b', 'one.ts', 3, 1), said('c')];
    const two = [asked('a'), edited('b', 'one.ts', 3, 1), edited('c', 'two.ts', 2, 0), said('d')];

    it('says nothing at all when it is turned off', () => {
      expect(changesByTurn(two, 'off').size).toBe(0);
    });

    it('withholds a single edit when only several are wanted', () => {
      expect(changesByTurn(one, 'multiple').size).toBe(0);
      expect(changesByTurn(two, 'multiple').size).toBe(1);
    });

    it('reports a single edit when any change is wanted', () => {
      expect(changesByTurn(one, 'always').get(2)?.files.map((file) => file.path)).toEqual(['one.ts']);
    });

    // A turn that changed nothing has nothing to say, whatever was asked for.
    it('still says nothing about a turn that changed nothing', () => {
      expect(changesByTurn([asked('a'), ran('b'), said('c')], 'always').size).toBe(0);
    });

    it('shows what a turn changed when it is not told which to show', () => {
      expect(changesByTurn(one).size).toBe(1);
    });
  });

  it('leaves an unchanged write out of a turn that did change other things', () => {
    const entries = [
      asked('a'),
      edited('b', 'one.ts', 2, 0),
      edited('c', 'two.ts', 0, 0),
      edited('d', 'three.ts', 1, 0),
      said('e'),
    ];

    const only = changesByTurn(entries).get(4);

    expect(only?.files.map((file) => file.path)).toEqual(['one.ts', 'three.ts']);
    expect(only?.added).toBe(3);
  });

  it('keeps each turn apart from the next', () => {
    const entries = [
      asked('a'),
      edited('b', 'one.ts', 1, 0),
      edited('c', 'two.ts', 1, 0),
      asked('d'),
      edited('e', 'three.ts', 5, 5),
      edited('f', 'four.ts', 5, 5),
      said('g'),
    ];

    const byTurn = changesByTurn(entries);

    expect([...byTurn.keys()]).toEqual([2, 6]);
    expect(byTurn.get(2)?.files.map((f) => f.path)).toEqual(['one.ts', 'two.ts']);
    expect(byTurn.get(6)?.files.map((f) => f.path)).toEqual(['three.ts', 'four.ts']);
  });

  // The turn being worked in has no question after it to end it.
  it('gathers the turn still in progress', () => {
    const entries = [asked('a'), edited('b', 'one.ts', 1, 0), edited('c', 'two.ts', 1, 0)];

    expect([...changesByTurn(entries).keys()]).toEqual([2]);
  });

  /**
   * A page opens partway through a session, so the rows above the first question belong to a
   * turn whose beginning was never read. Summarising them would be summarising a fragment.
   */
  it('says nothing about edits that arrived before the first question', () => {
    const entries = [edited('a', 'one.ts', 1, 0), edited('b', 'two.ts', 1, 0), asked('c'), said('d')];

    expect(changesByTurn(entries).size).toBe(0);
  });

  it('has nothing to say about an empty page', () => {
    expect(changesByTurn([]).size).toBe(0);
  });
});

/**
 * A patch applied rather than a file edited (#140 follow-up).
 *
 * `apply_patch` is given a whole envelope, so unlike `edit` and `create` it carries no path
 * in its arguments and its row has none. The summary required a row to have both a patch
 * and a path, so it skipped every one of them - measured on a real session here, 23 rows
 * carried a patch, 2 carried a path, and the turn summarised to nothing at all.
 */
describe('a turn that applied patches', () => {
  const diff = (path: string, added: number, removed: number) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,1 +1,1 @@',
      ...Array.from({ length: added }, (_, i) => `+line ${i}`),
      ...Array.from({ length: removed }, (_, i) => `-line ${i}`),
    ].join('\n');

  /** A row as `apply_patch` leaves one: a patch, and no path. */
  const applied = (key: string, patch: string): Entry =>
    ({
      kind: 'tool',
      key,
      name: 'Applying patch',
      summary: '',
      output: null,
      status: 'ok',
      patch,
    }) as Entry;

  it('summarises a patch that named no path on its row', () => {
    const entries = [asked('a'), applied('b', diff('C:/w/one.ts', 2, 1))];

    const turn = changesByTurn(entries, 'always').get(1);

    expect(turn?.files.map((f) => f.path)).toEqual(['C:/w/one.ts']);
    expect(turn?.added).toBe(2);
    expect(turn?.removed).toBe(1);
  });

  it('counts every file one patch touched', () => {
    const entries = [asked('a'), applied('b', `${diff('C:/w/one.ts', 2, 0)}\n${diff('C:/w/two.ts', 3, 1)}`)];

    const turn = changesByTurn(entries, 'always').get(1);

    expect(turn?.files.map((f) => f.path)).toEqual(['C:/w/one.ts', 'C:/w/two.ts']);
    expect(turn?.added).toBe(5);
    expect(turn?.removed).toBe(1);
  });

  it('gives each file only its own hunks to draw', () => {
    const entries = [asked('a'), applied('b', `${diff('C:/w/one.ts', 2, 0)}\n${diff('C:/w/two.ts', 3, 1)}`)];

    const files = changesByTurn(entries, 'always').get(1)?.files ?? [];

    expect(files[0]?.patches[0]).toContain('a/C:/w/one.ts');
    expect(files[0]?.patches[0]).not.toContain('two.ts');
  });

  it('joins a file two patches both touched', () => {
    const entries = [
      asked('a'),
      applied('b', diff('C:/w/one.ts', 2, 0)),
      applied('c', diff('C:/w/one.ts', 1, 1)),
    ];

    const turn = changesByTurn(entries, 'always').get(2);

    expect(turn?.files).toHaveLength(1);
    expect(turn?.files[0]?.patches).toHaveLength(2);
    expect(turn?.added).toBe(3);
  });

  /**
   * A single-file patch keeps the row's own path. That is the path the tool was given, in
   * the platform's own spelling, where the patch carries git's normalised one.
   */
  it('prefers the row path where the patch is about one file', () => {
    const named = (key: string, path: string, patch: string): Entry =>
      ({ kind: 'tool', key, name: 'Editing', summary: '', output: null, status: 'ok', path, patch }) as Entry;
    const entries = [asked('a'), named('b', 'C:\\w\\one.ts', diff('C:/w/one.ts', 1, 0))];

    expect(changesByTurn(entries, 'always').get(1)?.files[0]?.path).toBe('C:\\w\\one.ts');
  });

  /** A patch git did not write has no headers to read, so the row's path is all there is. */
  it('falls back to the row path for a patch with no headers', () => {
    const entries = [asked('a'), edited('b', 'C:\\w\\one.ts', 1, 0)];

    expect(changesByTurn(entries, 'always').get(1)?.files[0]?.path).toBe('C:\\w\\one.ts');
  });

  it('still says nothing about a row with neither a patch nor a path', () => {
    expect(changesByTurn([asked('a'), ran('b')], 'always').size).toBe(0);
  });

  it('still says nothing about a patch that changed nothing', () => {
    const empty = ['diff --git a/C:/w/one.ts b/C:/w/one.ts', '--- a/C:/w/one.ts', '+++ b/C:/w/one.ts', '@@ -1,1 +1,1 @@', ' same'].join('\n');

    expect(changesByTurn([asked('a'), applied('b', empty)], 'always').size).toBe(0);
  });
});
