import { describe, expect, it } from 'vitest';

import { startingEffort } from './models';
import type { ModelChoice, ReasoningEffort } from '../../shared/protocol';

const model = (reasoningEfforts: ReasoningEffort[], defaultReasoningEffort?: ReasoningEffort): ModelChoice => ({
  id: 'm',
  name: 'M',
  reasoningEfforts,
  defaultReasoningEffort,
  contexts: [],
  needsAgreement: false,
});

const FULL: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Something always has to be chosen: committing a model sends whatever the row holds, so a
 * row with no effort would leave that to the runtime rather than to the reader.
 */
describe('startingEffort', () => {
  it('has nothing to choose for a model that takes no direction', () => {
    expect(startingEffort(model([]), 'high')).toBeUndefined();
  });

  it('keeps the level the session is already using', () => {
    expect(startingEffort(model(FULL), 'xhigh')).toBe('xhigh');
  });

  it('prefers the model\u2019s own default over guessing', () => {
    expect(startingEffort(model(FULL, 'high'))).toBe('high');
  });

  // What the session uses is a decision someone made; a default is only a suggestion.
  it('prefers the session\u2019s level to the default', () => {
    expect(startingEffort(model(FULL, 'high'), 'low')).toBe('low');
  });

  it('ignores a default the model does not actually offer', () => {
    expect(startingEffort(model(['low', 'medium', 'high'], 'max'))).toBe('medium');
  });

  describe('with nothing to go on', () => {
    it('takes the level named medium where there is one', () => {
      expect(startingEffort(model(FULL))).toBe('medium');
      expect(startingEffort(model(['none', 'low', 'medium', 'high', 'xhigh', 'max']))).toBe('medium');
    });

    it('takes the middle of what is offered where none is named medium', () => {
      expect(startingEffort(model(['low', 'high', 'max']))).toBe('high');
    });

    it('takes the lower of two rather than the higher', () => {
      expect(startingEffort(model(['low', 'high']))).toBe('low');
    });

    it('takes the only level a model has', () => {
      expect(startingEffort(model(['high']))).toBe('high');
    });
  });

  // A level from another model means nothing here, so the row falls back rather than
  // marking something this model cannot do.
  it('falls back when the session uses a level this model lacks', () => {
    expect(startingEffort(model(['low', 'medium', 'high']), 'max')).toBe('medium');
  });
});
