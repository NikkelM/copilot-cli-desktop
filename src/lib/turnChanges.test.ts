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
        { path: 'one.ts', added: 3, removed: 1, edits: 1 },
        { path: 'two.ts', added: 2, removed: 0, edits: 1 },
      ],
      added: 5,
      removed: 1,
    });
  });

  // A file is often written more than once in a turn, and it is one file either way.
  it('counts a file once, however many times it was written', () => {
    const entries = [asked('a'), edited('b', 'one.ts', 3, 1), edited('c', 'one.ts', 4, 2), said('d')];

    const only = changesByTurn(entries).get(3);

    expect(only?.files).toEqual([{ path: 'one.ts', added: 7, removed: 3, edits: 2 }]);
    expect(only?.added).toBe(7);
  });

  /** Its own row says the same thing, and a line under every edit repeating it is noise. */
  it('says nothing about a turn with one edit in it', () => {
    const entries = [asked('a'), edited('b', 'one.ts', 3, 1), said('c')];

    expect(changesByTurn(entries).size).toBe(0);
  });

  it('says nothing about a turn that changed nothing', () => {
    const entries = [asked('a'), ran('b'), ran('c'), said('d')];

    expect(changesByTurn(entries).size).toBe(0);
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
