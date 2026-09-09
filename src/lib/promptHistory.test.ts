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
