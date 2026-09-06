// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ModelPicker } from './ModelPicker';
import type { ModelChoice } from '../../shared/protocol';

const models: ModelChoice[] = [
  { id: 'auto', name: 'Auto', reasoningEfforts: [], longContext: false, needsAgreement: false },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    reasoningEfforts: ['low', 'high'],
    longContext: true,
    needsAgreement: false,
  },
  { id: 'grok-4.6', name: 'Grok 4.6', reasoningEfforts: [], longContext: false, needsAgreement: true },
];

const picker = (props: Partial<Parameters<typeof ModelPicker>[0]> = {}) => {
  const onChoose = vi.fn();
  const onOpen = vi.fn(async () => models);
  render(<ModelPicker current={null} onOpen={onOpen} onChoose={onChoose} {...props} />);
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
      expect(control.textContent).toContain('long context');
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

    it('fetches it once however often it is opened', async () => {
      const { onOpen } = picker();

      await openMenu();
      await userEvent.click(screen.getAllByRole('button')[0]);
      await userEvent.click(screen.getAllByRole('button')[0]);

      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('says so when it cannot be fetched', async () => {
      picker({ onOpen: vi.fn(async () => Promise.reject(new Error('runtime is not running'))) });

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

      expect(screen.getByRole('button', { name: 'Claude Opus 5 with long context' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Auto with long context' })).toBeNull();
    });
  });

  describe('choosing', () => {
    it('reports the model on its own', async () => {
      const { onChoose } = picker();
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

      expect(onChoose).toHaveBeenCalledWith({
        model: 'claude-opus-5',
        reasoningEffort: undefined,
        contextTier: 'default',
      });
    });

    // Effort and context are settings of a model, so picking one picks its model too.
    it('reports the model when an effort is picked', async () => {
      const { onChoose } = picker();
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));

      expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5', reasoningEffort: 'high' }));
    });

    it('reports the model when a context size is picked', async () => {
      const { onChoose } = picker();
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 with long context' }));

      expect(onChoose).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-5', contextTier: 'long_context' }),
      );
    });

    // Changing one part of the setting must not quietly discard the other.
    it('keeps the effort already chosen when only the context changes', async () => {
      const { onChoose } = picker({ current: { model: 'claude-opus-5', reasoningEffort: 'low' } });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 with long context' }));

      expect(onChoose).toHaveBeenCalledWith({
        model: 'claude-opus-5',
        reasoningEffort: 'low',
        contextTier: 'long_context',
      });
    });

    it('keeps the context already chosen when only the effort changes', async () => {
      const { onChoose } = picker({ current: { model: 'claude-opus-5', contextTier: 'long_context' } });
      await openMenu();

      await userEvent.click(screen.getByRole('button', { name: 'Claude Opus 5 thinking high' }));

      expect(onChoose).toHaveBeenCalledWith({
        model: 'claude-opus-5',
        reasoningEffort: 'high',
        contextTier: 'long_context',
      });
    });

    // The settings belong to the model they were chosen for, not to the next one picked.
    it('does not carry one model\u2019s effort onto another', async () => {
      const { onChoose } = picker({ current: { model: 'auto', reasoningEffort: 'max' } });
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));

      expect(onChoose).toHaveBeenCalledWith({
        model: 'claude-opus-5',
        reasoningEffort: undefined,
        contextTier: 'default',
      });
    });

    it('closes once something is chosen', async () => {
      picker();
      await openMenu();

      await userEvent.click(screen.getByRole('option', { name: /Auto/ }));

      expect(screen.queryByRole('listbox')).toBeNull();
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
