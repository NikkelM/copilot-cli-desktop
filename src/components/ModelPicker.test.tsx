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
  const { container } = render(
    <ModelPicker
      current={null}
      models={models}
      usage={null}
      failed={null}
      onOpen={onOpen}
      onChoose={onChoose}
      {...props}
    />,
  );
  return { onChoose, onOpen, container };
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

    // A row of facts on its own gives no sign that pressing it does anything.
    it('turns the chevron with the menu', async () => {
      const { container } = picker({ current: { model: 'auto' } });
      const caret = () => container.querySelector('.caret')?.getAttribute('data-open');

      expect(caret()).toBe('false');
      await userEvent.click(screen.getAllByRole('button')[0]!);
      expect(caret()).toBe('true');
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
    expect(screen.getByLabelText('Loading model')).toBeTruthy();
  });

  it('has no placeholder left once the read comes back', () => {
    picker({ current: { model: 'claude-opus-5' } });
    expect(screen.queryByLabelText('Loading model')).toBeNull();
  });
    it('says so when the log never named a model', () => {
      picker({ current: null });
      expect(screen.getAllByRole('button')[0].textContent).toContain('No model recorded');
    });
  });

  /**
   * How much room is left is worth more than how much there is, but only a loaded session can
   * say: the figures live in the running session and are never written to the log.
   */
  describe('the context meter', () => {
    const usage = {
      totalTokens: 34_000,
      promptTokenLimit: 128_000,
      compactionThreshold: 102_400,
      categories: {
        systemPrompt: 4000,
        customInstructions: 1000,
        systemTools: 8000,
        mcpTools: 2000,
        messages: 19_000,
        freeSpace: 94_000,
      },
      compactions: 0,
    };

    it('shows what is used against what there is', () => {
      picker({ current: { model: 'grok-4.6' }, usage });
      expect(screen.getAllByRole('button')[0].textContent).toContain('34k/128k');
    });

    // Nothing is occupying the window of a session the runtime is not holding, so its size
    // alone is still the useful thing to say.
    it('falls back to the size when the session is not loaded', () => {
      picker({ current: { model: 'grok-4.6' }, usage: null });

      const control = screen.getAllByRole('button')[0];
      expect(control.textContent).toContain('128k');
      expect(control.textContent).not.toContain('/');
    });

    // The runtime resolves what `auto` actually ran as, so its limit is right where the
    // catalogue's entry for the named model would not be.
    it('trusts the runtime\u2019s limit over the catalogue\u2019s', () => {
      picker({ current: { model: 'auto' }, usage: { ...usage, promptTokenLimit: 936_000 } });
      expect(screen.getAllByRole('button')[0].textContent).toContain('34k/936k');
    });

    it('marks nothing while there is room left', () => {
      const { container } = picker({ current: { model: 'grok-4.6' }, usage });
      expect(container.querySelector('.model-tag.context.pressed')).toBeNull();
    });

    // Past this the runtime starts compacting history away, which is the reader's cue.
    it('marks the meter once compaction is due', () => {
      const { container } = picker({ current: { model: 'grok-4.6' }, usage: { ...usage, totalTokens: 110_000 } });
      expect(container.querySelector('.model-tag.context.pressed')).toBeTruthy();
    });

    it('marks it exactly at the threshold, not only past it', () => {
      const { container } = picker({ current: { model: 'grok-4.6' }, usage: { ...usage, totalTokens: 102_400 } });
      expect(container.querySelector('.model-tag.context.pressed')).toBeTruthy();
    });

    it('says what the room went on, largest first', () => {
      const { container } = picker({ current: { model: 'grok-4.6' }, usage });

      expect(container.querySelector('.model-tag.context')?.getAttribute('title')).toBe(
        'Context: 19k messages, 8k tools, 4k system prompt, 2k MCP tools, 1k instructions',
      );
    });

    // A session with no MCP servers should not read as having them.
    it('leaves out what is taking nothing', () => {
      const { container } = picker({
        current: { model: 'grok-4.6' },
        usage: { ...usage, categories: { ...usage.categories, mcpTools: 0, customInstructions: 0 } },
      });

      const title = container.querySelector('.model-tag.context')?.getAttribute('title');
      expect(title).not.toContain('MCP');
      expect(title).not.toContain('instructions');
    });

    it('says how much history has already been compacted away', () => {
      const { container } = picker({ current: { model: 'grok-4.6' }, usage: { ...usage, compactions: 3 } });
      expect(container.querySelector('.model-tag.context')?.getAttribute('title')).toContain('compacted 3 times');
    });

    it('counts a single compaction in words', () => {
      const { container } = picker({ current: { model: 'grok-4.6' }, usage: { ...usage, compactions: 1 } });
      expect(container.querySelector('.model-tag.context')?.getAttribute('title')).toContain('compacted once');
    });

    it('says nothing about compaction when none has happened', () => {
      const { container } = picker({ current: { model: 'grok-4.6' }, usage });
      expect(container.querySelector('.model-tag.context')?.getAttribute('title')).not.toContain('compacted');
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

      expect(screen.getByText('No price listed')).toBeTruthy();
    });

    // It used to vanish, which is the largest jump of all: in the settings window nothing is
    // in use, so the block appeared on hover and collapsed again the moment the pointer moved.
    it('keeps the block before the pointer has been anywhere', async () => {
      picker({ current: null });
      await openMenu();

      expect(screen.getByText(/Cost per 1M tokens/)).toBeTruthy();
      expect(screen.getByText('Hover a model to see its price')).toBeTruthy();
    });

    it('names no model until there is one to name', async () => {
      picker({ current: null });
      await openMenu();

      expect(screen.getByRole('listbox').querySelector('.model-prices-of')).toBeNull();
    });

    // Three prices, one line saying there are none, or nothing at all: the block keeps the
    // same rows for all of them, or the list under it moves as the pointer goes down it.
    it('reserves the same rows whatever it has to say', async () => {
      picker({ current: null });
      await openMenu();

      // The menu is drawn on the body rather than inside the picker, so it is found by role.
      const rows = () => screen.getByRole('listbox').querySelectorAll('.model-price').length;
      const spans = () => screen.getByRole('listbox').querySelectorAll('.model-price.wide').length;

      // Nothing to say, said across the rows three prices would have taken.
      expect(rows()).toBe(1);
      expect(spans()).toBe(1);

      await userEvent.hover(screen.getByRole('option', { name: /Claude Opus 5/ }));
      expect(rows()).toBe(3);
      expect(spans()).toBe(0);

      await userEvent.hover(screen.getByRole('option', { name: /Grok 4\.6/ }));
      expect(rows()).toBe(1);
      expect(spans()).toBe(1);
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

    // Auto offers no efforts and one context, so neither of those lines belongs to it. Its
    // routing line does, which is the one line it has (#215).
    const row = screen.getByRole('option', { name: /Auto/ }).closest('.model-row')!;
    const lines = [...row.querySelectorAll('.model-line')].map((line) => line.textContent);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Routing');
  });

  describe('changing the model already in use', () => {
    /**
     * Touching the effort or the room size of the model already selected is not composing a
     * choice, it is changing the thing in front of you. Staged and not committed, it looked
     * chosen until the menu closed and then was gone.
     */
    it('commits an effort chosen on the row in use', async () => {
      const onChoose = vi.fn();
      picker({ onChoose, current: { model: 'claude-opus-5', reasoningEffort: 'low' } });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));

      expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5', reasoningEffort: 'high' }));
    });

    it('commits a room size chosen on the row in use', async () => {
      const onChoose = vi.fn();
      picker({ onChoose, current: { model: 'claude-opus-5', contextTier: 'default' } });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 with 936k of context' }));

      expect(onChoose).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-5', contextTier: 'long_context' }),
      );
    });

    /** Carries the rest of the row, not just the part that moved. */
    it('keeps what the row already held', async () => {
      const onChoose = vi.fn();
      picker({ onChoose, current: { model: 'claude-opus-5', reasoningEffort: 'high', contextTier: 'long_context' } });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 with 200k of context' }));

      expect(onChoose).toHaveBeenCalledWith(
        expect.objectContaining({ reasoningEffort: 'high', contextTier: 'default' }),
      );
    });

    /** Adjusting one of these often means adjusting the other. */
    it('leaves the menu open to adjust the rest', async () => {
      picker({ current: { model: 'claude-opus-5', reasoningEffort: 'low' } });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));

      expect(screen.getByRole('listbox')).toBeTruthy();
    });

    /**
     * On any other row the same click is one part of a choice not yet made. Committing it
     * would move the session onto a model nobody asked for, which for a session means a
     * resume as well.
     */
    it('only stages the same click on a model not in use', async () => {
      const onChoose = vi.fn();
      picker({ onChoose, current: { model: 'auto' } });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));

      expect(onChoose).not.toHaveBeenCalled();
    });

    it('sends what was staged once the model is chosen', async () => {
      const onChoose = vi.fn();
      picker({ onChoose, current: { model: 'auto' } });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));
      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

      expect(onChoose).toHaveBeenCalledTimes(1);
      expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5', reasoningEffort: 'high' }));
    });
  });

  describe('how auto routes', () => {    /** The runtime refuses a routing preference against any other model. */
    it('offers it on auto alone', async () => {
      picker();
      await openMenu();

      const other = screen.getByRole('option', { name: /Claude Opus 5/ }).closest('.model-row')!;
      expect([...other.querySelectorAll('.model-line')].map((l) => l.textContent).join()).not.toContain('Routing');
    });

    /**
     * Three of the four the runtime takes. The SDK calls `fast` an integrator-only latency
     * preset and says it is not a first-party product preference.
     */
    it('offers the three that are product preferences', async () => {
      picker();
      await openMenu();

      const row = screen.getByRole('option', { name: /Auto/ }).closest('.model-row')!;
      const offered = [...row.querySelectorAll('.model-option')].map((option) => option.textContent);

      expect(offered).toEqual(['efficiency', 'balance', 'intelligence']);
      expect(offered, 'fast is not a preference to offer beside the others').not.toContain('fast');
    });

    it('sends the preference with the model, which is how the runtime takes it', async () => {
      const onChoose = vi.fn();
      picker({ onChoose });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Auto routing for intelligence' }));
      await userEvent.click(screen.getByRole('option', { name: /Auto/ }));

      expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ model: 'auto', autoTier: 'intelligence' }));
    });

    /** Untouched, it must send nothing: an unasked preference is not a choice to make. */
    it('sends none where none was chosen', async () => {
      const onChoose = vi.fn();
      picker({ onChoose });
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Auto/ }));

      expect(onChoose.mock.calls[0]?.[0]).not.toHaveProperty('autoTier');
    });

    /**
     * Every other choice in this menu takes effect on the next message. The runtime only
     * records this one, committing it on a later turn that uses auto, so saying it is set
     * would be claiming something that has not happened.
     */
    it('says a preference is waiting rather than in force', async () => {
      picker({ autoTier: { current: 'balance', pending: 'intelligence' } });
      await openMenu();

      expect(screen.getByText('waiting for the next prompt')).toBeTruthy();
    });
    it('says nothing about waiting when nothing is', async () => {
      picker({ autoTier: { current: 'balance' } });
      await openMenu();

      expect(screen.queryByText('waiting for the next prompt')).toBeNull();
    });

    /** The newer of the two, and the one the reader made. */
    it('starts from a preference asked for over the one in force', async () => {
      picker({ autoTier: { current: 'balance', pending: 'efficiency' } });
      await openMenu();

      expect(screen.getByRole('button', { name: 'Auto routing for efficiency' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
    });
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
