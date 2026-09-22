import { describe, expect, it } from 'vitest';

import { promptHistory } from './promptHistory';
import type { TranscriptEvent } from '../../shared/protocol';

function said(content: unknown, type = 'user.message'): TranscriptEvent {
  return { id: `e${Math.random()}`, type, timestamp: new Date().toISOString(), data: { content } } as TranscriptEvent;
}

describe('promptHistory', () => {
  it('reads back what was sent, newest first', () => {
    expect(promptHistory([said('one'), said('two'), said('three')])).toEqual(['three', 'two', 'one']);
  });

  it('ignores everything that is not something the reader typed', () => {
    expect(promptHistory([said('mine'), said('theirs', 'assistant.message')])).toEqual(['mine']);
  });

  it('leaves out blank prompts, which are nothing to go back to', () => {
    expect(promptHistory([said('   '), said('real')])).toEqual(['real']);
  });

  it('trims, so a recalled prompt is what was sent rather than how it was typed', () => {
    expect(promptHistory([said('  spaced  ')])).toEqual(['spaced']);
  });

  it('folds a prompt repeated back to back into one entry', () => {
    expect(promptHistory([said('again'), said('again'), said('other')])).toEqual(['other', 'again']);
  });

  it('keeps a prompt that comes round again later', () => {
    expect(promptHistory([said('a'), said('b'), said('a')])).toEqual(['a', 'b', 'a']);
  });

  it('survives an event whose content is not text', () => {
    expect(promptHistory([said(undefined), said({ parts: [] }), said('ok')])).toEqual(['ok']);
  });
});

/**
 * The CLI's `commandHistoryMaxSize`, which says how many prompts can be stepped back
 * through. Counted from the newest end: the entry somebody is reaching for is the one they
 * just sent, not the one they sent first (#205).
 */
describe('how many it keeps', () => {
  it('keeps every prompt when it is not told a number', () => {
    // Longer than any plausible default, so this catches a bound that crept in rather than
    // passing because the list happened to be short.
    const many = Array.from({ length: 200 }, (_, at) => said(`p${at}`));

    expect(promptHistory(many)).toHaveLength(200);
  });

  it('keeps the newest, and drops what fell off the back', () => {
    expect(promptHistory([said('a'), said('b'), said('c')], 2)).toEqual(['c', 'b']);
  });

  it('keeps nothing when it is allowed nothing', () => {
    expect(promptHistory([said('a'), said('b')], 0)).toEqual([]);
  });

  // Room for three with two to fill it: counting back from the end without a floor would
  // take the last one only.
  it('is not troubled by room for more than there are', () => {
    expect(promptHistory([said('a'), said('b')], 3)).toEqual(['b', 'a']);
  });

  /** Folded first, so the limit counts entries somebody can reach rather than messages. */
  it('counts what is left after repeats are folded together', () => {
    expect(promptHistory([said('a'), said('b'), said('b'), said('c')], 2)).toEqual(['c', 'b']);
  });
});
