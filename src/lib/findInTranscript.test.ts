import { describe, expect, it } from 'vitest';

import { findMatches, stepMatch, textOf } from './findInTranscript';
import type { Entry } from './transcriptEntries';

const said = (body: string): Entry => ({ kind: 'message', key: body, variant: 'assistant', body });
const thought = (body: string): Entry => ({ kind: 'reasoning', key: body, body });
const ran = (over: Partial<Extract<Entry, { kind: 'tool' }>> = {}): Entry => ({
  kind: 'tool',
  key: 't1',
  name: 'powershell',
  summary: 'list the folder',
  output: null,
  status: 'ok',
  ...over,
});

describe('what a row can be found by', () => {
  it('is what was said', () => {
    expect(textOf(said('the quick brown fox'))).toContain('quick');
  });

  it('is the thinking as well', () => {
    expect(textOf(thought('weighing it up'))).toContain('weighing');
  });

  /**
   * A folded row can still be found in. The reader can see the row and expects the word in
   * it to turn up, which is the whole difference between this and searching the sessions.
   */
  it.each([
    ['name', { name: 'ripgrep' }, 'ripgrep'],
    ['summary', { summary: 'count the lines' }, 'count the lines'],
    ['command', { command: 'Get-ChildItem -Recurse' }, 'Recurse'],
    ['output', { output: 'three files found' }, 'three files'],
    ['answer', { answer: 'the second one' }, 'second'],
    ['choices', { choices: ['keep', 'discard'] }, 'discard'],
    ['patch', { patch: '@@ -1 +1 @@\n-old\n+new' }, '+new'],
  ])("is a tool call's %s", (_what, over, wanted) => {
    expect(textOf(ran(over))).toContain(wanted);
  });

  it('says nothing for the parts a row does not have', () => {
    expect(textOf(ran())).not.toContain('null');
    expect(textOf(ran())).not.toContain('undefined');
  });
});

describe('which rows hold the words', () => {
  const rows = [said('first mention'), said('nothing here'), thought('second mention'), ran({ output: 'third mention' })];

  it('gives their places, oldest first', () => {
    expect(findMatches(rows, 'mention')).toEqual([0, 2, 3]);
  });

  it('ignores the case of either side', () => {
    expect(findMatches(rows, 'MENTION')).toEqual([0, 2, 3]);
    expect(findMatches([said('SHOUTING')], 'shouting')).toEqual([0]);
  });

  it('finds nothing for words nobody said', () => {
    expect(findMatches(rows, 'elephant')).toEqual([]);
  });

  it.each(['', '   '])('finds nothing for %s, rather than everything', (query) => {
    expect(findMatches(rows, query)).toEqual([]);
  });

  it('ignores space around the words', () => {
    expect(findMatches(rows, '  mention  ')).toEqual([0, 2, 3]);
  });

  /** Taking the reader to the same row three times would read as the walk being stuck. */
  it('counts a row once however often the words appear in it', () => {
    expect(findMatches([said('again and again and again')], 'again')).toEqual([0]);
  });
});

describe('walking the hits', () => {
  it('goes forwards and backwards', () => {
    expect(stepMatch(3, 0, 1)).toBe(1);
    expect(stepMatch(3, 2, -1)).toBe(1);
  });

  /** A key that stops working at the last match reads as broken rather than as finished. */
  it('wraps at either end', () => {
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
  });

  it('has nowhere to go when nothing was found', () => {
    expect(stepMatch(0, -1, 1)).toBe(-1);
  });

  /** The first step from nowhere lands on the first hit rather than the second. */
  it('starts at the beginning when it has not started', () => {
    expect(stepMatch(3, -1, 1)).toBe(0);
  });
});
