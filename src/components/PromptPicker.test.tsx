// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { SessionPrompt } from '../../shared/protocol';
import { PromptPicker } from './PromptPicker';

const prompt = (at: string, text: string): SessionPrompt => ({ at, text });

const three = [
  prompt('2026-01-03T00:00:00.000Z', 'rewrite the parser'),
  prompt('2026-01-02T00:00:00.000Z', 'add a test for the edge case'),
  prompt('2026-01-01T00:00:00.000Z', 'fix the crash on startup'),
];

const picker = (over: Partial<Parameters<typeof PromptPicker>[0]> = {}) => {
  const onOpen = vi.fn();
  const onChoose = vi.fn();
  const view = render(
    <PromptPicker prompts={three} failed={null} at={null} onOpen={onOpen} onChoose={onChoose} {...over} />,
  );
  return { onOpen, onChoose, ...view };
};

const rows = () => screen.queryAllByRole('option');
/** The prompt itself, apart from the time beside it. */
const said = () => rows().map((row) => row.querySelector('.prompt-row-text')?.textContent);

describe('the list of a session prompts', () => {
  it('says nothing until it is opened', () => {
    picker();
    expect(rows()).toEqual([]);
  });

  /**
   * Reading them means reading the whole log, a second on the largest here, so nothing is
   * asked for until somebody actually wants the list.
   */
  it('asks for them only when it is opened', async () => {
    const { onOpen } = picker({ prompts: null });

    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('lists them once open', async () => {
    picker();

    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));

    expect(said()).toEqual(['rewrite the parser', 'add a test for the edge case', 'fix the crash on startup']);
  });

  it('says how many there are without being opened', () => {
    picker();
    expect(screen.getByRole('button', { name: /Prompts/ }).textContent).toContain('3');
  });

  it('goes to the one that is pressed, and closes', async () => {
    const { onChoose } = picker();

    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
    await userEvent.click(screen.getByText('fix the crash on startup'));

    expect(onChoose).toHaveBeenCalledExactlyOnceWith(three[2]);
    expect(rows()).toEqual([]);
  });

  /** Thousands of them on a long session, so narrowing is what anybody opening this does. */
  it('narrows to what is typed', async () => {
    picker();

    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
    await userEvent.type(screen.getByRole('searchbox'), 'crash');

    expect(rows()).toHaveLength(1);
    expect(screen.getByText('fix the crash on startup')).toBeTruthy();
  });

  it('says so when nothing matches rather than showing an empty list', async () => {
    picker();

    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
    await userEvent.type(screen.getByRole('searchbox'), 'nothing says this');

    expect(screen.getByText('No prompt says that.')).toBeTruthy();
  });

  it('tells a session that has been asked nothing apart from one that has no match', async () => {
    picker({ prompts: [] });

    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));

    expect(screen.getByText('Nothing asked yet.')).toBeTruthy();
  });

  it('says when they could not be read', async () => {
    picker({ prompts: null, failed: 'the log is gone' });

    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));

    expect(screen.getByText('the log is gone')).toBeTruthy();
  });

  /** The list says where you are as well as where you could go. */
  it('marks the one it last sent the reader to', async () => {
    picker({ at: '2026-01-02T00:00:00.000Z' });

    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));

    // Both the state a reader hears and the class that paints it: either alone would let
    // the row stop being marked while the test went on passing.
    const marked = rows().filter((row) => row.getAttribute('aria-selected') === 'true');
    expect(marked.map((row) => row.querySelector('.prompt-row-text')?.textContent)).toEqual([
      'add a test for the edge case',
    ]);
    expect(rows().filter((row) => row.classList.contains('chosen'))).toEqual(marked);
  });

  it('marks nothing when it has sent the reader nowhere yet', async () => {
    picker();

    await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));

    expect(rows().filter((row) => row.classList.contains('chosen'))).toEqual([]);
  });

  describe('from the keyboard', () => {
    it('takes the keyboard to the filter as it opens', async () => {
      picker();

      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));

      expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    });

    it('goes to the first match on Enter', async () => {
      const { onChoose } = picker();

      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
      await userEvent.type(screen.getByRole('searchbox'), 'crash{Enter}');

      expect(onChoose).toHaveBeenCalledExactlyOnceWith(three[2]);
    });

    it('walks down out of the filter into the rows', async () => {
      picker();

      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement?.textContent).toContain('rewrite the parser');

      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement?.textContent).toContain('add a test for the edge case');
    });

    it('comes back up out of the rows to the filter', async () => {
      picker();

      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
      await userEvent.keyboard('{ArrowDown}{ArrowUp}');

      expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    });

    it('closes on Escape', async () => {
      picker();

      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
      await userEvent.keyboard('{Escape}');

      expect(rows()).toEqual([]);
    });
  });

  /**
   * A dropdown holding every prompt of a long session is one nobody can scroll - there are
   * 2,050 on the largest log here. The newest are the end somebody jumps to most, and the
   * filter reaches the rest, so what is capped is what is drawn rather than what is findable.
   */
  describe('a session with thousands of them', () => {
    const many = Array.from({ length: 260 }, (_, index) =>
      prompt(`2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`, `prompt ${index}`),
    );

    it('draws only the newest, and says how many are left', async () => {
      picker({ prompts: many });

      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));

      expect(rows()).toHaveLength(200);
      expect(screen.getByText('60 older. Filter to reach them.')).toBeTruthy();
    });

    it('reaches the rest through the filter', async () => {
      picker({ prompts: many });

      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
      await userEvent.type(screen.getByRole('searchbox'), 'prompt 259');

      expect(rows()).toHaveLength(1);
      expect(screen.queryByText(/older\. Filter to reach them\./)).toBeNull();
    });
  });
});
