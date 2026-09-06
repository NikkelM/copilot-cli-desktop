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

  /**
   * Someone changing model is saying something about the model, not about how hard they
   * want it to think, so a level the model lacks should land as near to it as possible.
   */
  describe('when the model does not have the level in use', () => {
    it('steps down one rather than starting over', () => {
      expect(startingEffort(model(['low', 'medium', 'high']), 'xhigh')).toBe('high');
    });

    it('steps up when there is nothing below', () => {
      expect(startingEffort(model(['high', 'xhigh', 'max']), 'low')).toBe('high');
    });

    it('takes the nearest rather than the next one along', () => {
      expect(startingEffort(model(['none', 'max']), 'xhigh')).toBe('max');
    });

    // Spending more than was asked for is the worse of the two mistakes.
    it('goes down rather than up when both are equally close', () => {
      expect(startingEffort(model(['medium', 'max']), 'high')).toBe('medium');
    });

    it('finds the nearest however the model happens to order its levels', () => {
      expect(startingEffort(model(['max', 'low', 'high']), 'xhigh')).toBe('high');
    });

    // Nearness beats a preference the model expressed about nothing in particular.
    it('prefers the nearest level to the model\u2019s own default', () => {
      expect(startingEffort(model(['low', 'medium', 'high'], 'low'), 'xhigh')).toBe('high');
    });
  });

  /**
   * The runtime's levels are its own to change. One added after this was written must not
   * become invisible here, since invisible means never offered as the nearest thing to
   * anything, and one removed must not leave the scale stranded.
   */
  describe('levels this version has never heard of', () => {
    const unknown = 'ultra' as ReasoningEffort;

    // The runtime lists a model's levels from least to most, so an unknown one still has
    // neighbours that place it.
    it('ranks an unknown level between the ones around it', () => {
      expect(startingEffort(model(['low', unknown, 'max']), 'medium')).toBe('low');
      expect(startingEffort(model(['low', unknown, 'max']), 'xhigh')).toBe(unknown);
    });

    it('ranks an unknown level above the last known one', () => {
      expect(startingEffort(model(['low', 'medium', unknown]), 'max')).toBe(unknown);
    });

    it('ranks an unknown level below the first known one', () => {
      expect(startingEffort(model([unknown, 'high', 'max']), 'none')).toBe(unknown);
    });

    // With nothing known around it there is no telling where it belongs, so it is not
    // offered as the nearest thing to something else.
    it('does not guess at a level with no known neighbours', () => {
      expect(startingEffort(model([unknown]), 'max')).toBe(unknown);
    });

    // A level the session uses that this version cannot place is no worse than none.
    it('falls back when the session itself uses a level it cannot place', () => {
      expect(startingEffort(model(['low', 'medium', 'high']), unknown)).toBe('medium');
    });

    // A level the runtime drops simply stops appearing; the scale naming it is harmless.
    it('is unbothered by a level the runtime no longer offers', () => {
      expect(startingEffort(model(['low', 'high']), 'medium')).toBe('low');
    });
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
});
