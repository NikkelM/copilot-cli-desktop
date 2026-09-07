// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ModelPicker } from './ModelPicker';
import type { ModelChoice } from '../../shared/protocol';

const models: ModelChoice[] = [
  { id: 'auto', name: 'Auto', reasoningEfforts: [], contexts: [], needsAgreement: false },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    reasoningEfforts: ['low', 'high'],
    contexts: [
      { tier: 'default', maxPromptTokens: 200_000 },
      { tier: 'long_context', maxPromptTokens: 936_000 },
    ],
    prices: { input: 500, cachedInput: 50, output: 2500 },
    needsAgreement: false,
  },
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    reasoningEfforts: [],
    contexts: [{ tier: 'default', maxPromptTokens: 128_000 }],
    needsAgreement: true,
  },
];

const picker = (props: Partial<Parameters<typeof ModelPicker>[0]> = {}) => {
  const onChoose = vi.fn();
  const onOpen = vi.fn();
  render(
    <ModelPicker current={null} models={models} failed={null} onOpen={onOpen} onChoose={onChoose} {...props} />,
  );
  return { onChoose, onOpen };
};

const openMenu = async () => {
  await userEvent.click(screen.getAllByRole('button')[0]);
  await screen.findByRole('option', { name: /Claude Opus 5/ });
};

describe('ModelPicker', () => {
  describe('what it shows closed', () => {
    it('names the model, the effort and the context together', () => {
      picker({ current: { model: 'claude-opus-5', reasoningEffort: 'high', contextTier: 'long_context' } });

      const control = screen.getAllByRole('button')[0];
      expect(control.textContent).toContain('claude-opus-5');
      expect(control.textContent).toContain('high');
      expect(control.textContent).toContain('936k');
    });

    // Standard context is what almost every session uses, so saying so adds nothing.
    it('says nothing about context when it is the standard one', () => {
      picker({ current: { model: 'auto', contextTier: 'default' } });
      expect(screen.getAllByRole('button')[0].textContent).not.toContain('context');
    });

    // A model that takes no direction on thinking has no level to report.
    it('says nothing about effort when the model takes none', () => {
      picker({ current: { model: 'auto', reasoningEffort: 'none' } });
      expect(screen.getAllByRole('button')[0].textContent).not.toContain('none');
    });

  // Reading the log takes a moment, and switching sessions used to flash a claim that the
  // session had no model before the answer arrived.
  it('says nothing at all until the log has been read', () => {
    picker({ current: undefined });
    expect(screen.getAllByRole('button')[0].textContent).toBe('');
  });

  /**
   * Blanking the text alone collapsed the control to a small empty blob on every session
   * switch, then snapped it back. It has to hold its shape while the read is in flight.
   */
  it('keeps its shape while the log is being read', () => {
    picker({ current: undefined });
    expect(screen.getByLabelText('Reading which model this session uses')).toBeTruthy();
  });

  it('has no placeholder left once the read comes back', () => {
    picker({ current: { model: 'claude-opus-5' } });
    expect(screen.queryByLabelText('Reading which model this session uses')).toBeNull();
  });
    it('says so when the log never named a model', () => {
      picker({ current: null });
      expect(screen.getAllByRole('button')[0].textContent).toContain('No model recorded');
    });
  });

  describe('the catalogue', () => {
    // Listing models starts the shared server, which is exactly what this app avoids doing
    // for anything a reader has not asked for.
    it('asks for nothing until the list is opened', () => {
      const { onOpen } = picker();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('asks for a fresh list when opened', async () => {
      const { onOpen } = picker();

      await openMenu();

      expect(onOpen).toHaveBeenCalled();
    });

    // The list is remembered between runs, so it is usually there before the runtime is.
    it('shows a remembered list before any fetch answers', () => {
      picker();
      expect(screen.getAllByRole('button')[0]).toBeTruthy();
    });

    it('says so when it cannot be fetched', async () => {
      picker({ models: null, failed: 'runtime is not running' });

      await userEvent.click(screen.getAllByRole('button')[0]);

      expect(await screen.findByText(/runtime is not running/)).toBeTruthy();
    });

    it('marks the model in use', async () => {
      picker({ current: { model: 'claude-opus-5' } });
      await openMenu();

      expect(screen.getByRole('option', { name: /Claude Opus 5/ }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('option', { name: /Auto/ }).getAttribute('aria-selected')).toBe('false');
    });

    // A model whose terms have not been accepted is listed but will not answer.
    it('says which models cannot be used yet', async () => {
      picker();
      await openMenu();

      expect(screen.getByRole('option', { name: /Grok 4.6/ }).textContent).toContain('terms not accepted');
    });

    // Most models have one context size, and offering a choice that does nothing is worse
    // than offering none.
    it('offers context sizes only for models that have more than one', async () => {
      picker();
      await openMenu();

      expect(screen.getByRole('button', { name: 'Claude Opus 5 with 936k of context' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Auto with long context' })).toBeNull();
    });
  });

  describe('what a model costs', () => {
    // The one model a reader is actually spending on; twenty-one price tables would bury
    // the list they came for.
    it('shows the price of the model in use', async () => {
      picker({ current: { model: 'claude-opus-5' } });
      await openMenu();

      expect(screen.getByText(/Cost per 1M tokens/)).toBeTruthy();
      expect(screen.getByText('500 credits')).toBeTruthy();
      expect(screen.getByText('2,500 credits')).toBeTruthy();
    });

    // Auto has no price of its own: what it costs depends on where it routes. The block
    // still shows, so the list does not move as the pointer passes over it.
    it('says a model is not priced rather than showing nothing', async () => {
      picker({ current: { model: 'grok-4.6' } });
      await openMenu();

      expect(screen.getByText('Not priced on its own')).toBeTruthy();
    });

    it('shows no price when nothing is in use yet', async () => {
      picker({ current: null });
      await openMenu();

      expect(screen.queryByText(/Cost per 1M tokens/)).toBeNull();
    });

    describe('following what the reader is looking at', () => {
      it('shows the price of the model under the pointer', async () => {
        picker({ current: { model: 'auto' } });
        await openMenu();

        await userEvent.hover(screen.getByRole('option', { name: /Claude Opus 5/ }));

        expect(screen.getByText('500 credits')).toBeTruthy();
      });

      it('names the model the price belongs to', async () => {
        picker({ current: { model: 'auto' } });
        await openMenu();

        await userEvent.hover(screen.getByRole('option', { name: /Claude Opus 5/ }));

        expect(screen.getByText(/Claude Opus 5/, { selector: '.model-prices-of' })).toBeTruthy();
      });

      it('goes back to the model in use once the pointer leaves the list', async () => {
        picker({ current: { model: 'claude-opus-5' } });
        await openMenu();
        await userEvent.hover(screen.getByRole('option', { name: /Auto/ }));

        await userEvent.unhover(screen.getByRole('listbox'));

        expect(screen.getByText('500 credits')).toBeTruthy();
      });

      // Following the keyboard too, since the picker must not need a pointer at all.
      it('follows focus as well as the pointer', async () => {
        picker({ current: { model: 'auto' } });
        await openMenu();

        await act(async () => screen.getByRole('option', { name: /Claude Opus 5/ }).focus());

        expect(screen.getByText('500 credits')).toBeTruthy();
      });
    });
  });
  describe('choosing', () => {
    // Committing sends whatever the row holds, so a row that holds nothing would leave the
    // effort to the runtime rather than to the reader.
    it('always reports an effort, even when nothing was picked', async () => {
      const { onChoose } = picker();
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

      expect(onChoose).toHaveBeenCalledWith({
        model: 'claude-opus-5',
        reasoningEffort: 'low',
        contextTier: 'default',
      });
    });

    // The whole point of two steps: a reader setting an effort usually wants to say
    // something about the context too, and committing on the first would send them back in.
    it('changes nothing until the model name is clicked', async () => {
      const { onChoose } = picker();
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));
      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 with 936k of context' }));

      expect(onChoose).not.toHaveBeenCalled();
      expect(screen.getByRole('listbox')).toBeTruthy();
    });

    it('commits everything set on the row when the name is clicked', async () => {
      const { onChoose } = picker();
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));
      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 with 936k of context' }));
      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

      expect(onChoose).toHaveBeenCalledTimes(1);
      expect(onChoose).toHaveBeenCalledWith({
        model: 'claude-opus-5',
        reasoningEffort: 'high',
        contextTier: 'long_context',
      });
    });

    it('marks what has been set but not yet committed', async () => {
      picker();
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));

      expect(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(screen.getByRole('button', { name: 'Claude Opus 5 thinking low' }).getAttribute('aria-pressed')).toBe(
        'false',
      );
    });

    // Opening the menu and committing the model already in use must change nothing.
    it('starts each row from what that model already runs with', async () => {
      const { onChoose } = picker({ current: { model: 'claude-opus-5', reasoningEffort: 'low', contextTier: 'long_context' } });
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

      expect(onChoose).toHaveBeenCalledWith({
        model: 'claude-opus-5',
        reasoningEffort: 'low',
        contextTier: 'long_context',
      });
    });

    /**
     * Someone changing model almost always wants to keep the effort and the context they
     * were working at, and restating both on the new row is work the picker can do for them.
     */
    describe('carrying the session\u2019s settings onto every row', () => {
      it('starts another model from the effort the session is using', async () => {
        const { onChoose } = picker({ current: { model: 'auto', reasoningEffort: 'high' } });
        await openMenu();

        await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'high' }));
      });

      it('starts another model from the context the session is using', async () => {
        const { onChoose } = picker({ current: { model: 'auto', contextTier: 'long_context' } });
        await openMenu();

        await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ contextTier: 'long_context' }));
      });

      it('marks what it carried over, so the row shows what will be sent', async () => {
        picker({ current: { model: 'auto', reasoningEffort: 'high' } });
        await openMenu();

        expect(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }).getAttribute('aria-pressed')).toBe(
          'true',
        );
      });

      // Marking a level the model does not have would promise something it cannot do, so
      // the row takes the nearest level it does have.
      it('takes the nearest level when the model lacks the one in use', async () => {
        const { onChoose } = picker({ current: { model: 'auto', reasoningEffort: 'max' } });
        await openMenu();

        await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'high' }));
      });

      it('falls back to the standard size when the model has no larger one', async () => {
        const { onChoose } = picker({ current: { model: 'claude-opus-5', contextTier: 'long_context' } });
        await openMenu();

        await userEvent.click(screen.getByRole('option', { name: /Grok 4.6/ }));

        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ contextTier: 'default' }));
      });
    });

    it('closes once something is chosen', async () => {
      picker();
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Auto/ }));

      expect(screen.queryByRole('listbox')).toBeNull();
    });

    // A row half-set and left is not a decision, so reopening should not remember it.
    it('forgets what was set on a row that was never committed', async () => {
      const { onChoose } = picker();
      await openMenu();
      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));

      await userEvent.keyboard('{Escape}');
      await openMenu();
      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

      expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'low' }));
    });
  });

  // Levels and context sizes read as one another when they share a line, especially since
  // both are small chips.
  it('gives the model, its effort and its context a line each', async () => {
    picker();
    await openMenu();

    const row = screen.getByRole('option', { name: /Claude Opus 5/ }).closest('.model-row')!;
    const lines = [...row.querySelectorAll('.model-line')].map((line) => line.textContent);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Effort');
    expect(lines[1]).toContain('Context');
  });

  it('leaves out the lines a model has no choices for', async () => {
    picker();
    await openMenu();

    const row = screen.getByRole('option', { name: /Auto/ }).closest('.model-row')!;
    expect(row.querySelectorAll('.model-line')).toHaveLength(0);
  });
  it('closes when Escape is pressed', async () => {
    picker();
    await openMenu();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes when something else is clicked', async () => {
    picker();
    await openMenu();

    await userEvent.click(document.body);

    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
