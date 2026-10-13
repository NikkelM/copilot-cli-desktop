// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { SessionPrompt } from '../../shared/protocol';
import { PromptPicker } from './PromptPicker';

const prompt = (at: string, text: string): SessionPrompt => ({ at, text });

/**
 * As the sidecar hands them over: oldest first, which is the order of the log they were read
 * from. Written that way round on purpose - a fixture already in the order the list draws
 * would let the list stop ordering them and say nothing about it.
 */
const three = [
  prompt('2026-01-01T00:00:00.000Z', 'fix the crash on startup'),
  prompt('2026-01-02T00:00:00.000Z', 'add a test for the edge case'),
  prompt('2026-01-03T00:00:00.000Z', 'rewrite the parser'),
];

/** The newest, which is what the list puts at the top. */
const newest = three[2]!;
/** The oldest, which is what it puts at the bottom. */
const oldest = three[0]!;

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

  /** Newest at the top, oldest at the bottom - the other way round from the log. */
  it('lists them newest first, whatever order they arrived in', async () => {
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

    expect(onChoose).toHaveBeenCalledExactlyOnceWith(oldest);
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

      expect(onChoose).toHaveBeenCalledExactlyOnceWith(oldest);
    });

    /** Down from the box reaches the top row, which is the newest. */
    it('walks down out of the filter into the rows', async () => {
      picker();

      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement?.textContent).toContain(newest.text);

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
   * 2,050 on the largest log here. A page is drawn at a time and the next arrives on
   * reaching the bottom, so what is bounded is the laying out rather than what is reachable.
   *
   * jsdom lays nothing out, so the list's measurements are the test's to state.
   */
  describe('a session with thousands of them', () => {
    // Oldest first, as the sidecar hands them over, and genuinely ascending in time: a
    // fixture whose moments jump about would say nothing about an order built from them.
    const many = Array.from({ length: 460 }, (_, index) =>
      prompt(new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(), `prompt ${index}`),
    );

    /** Scroll the list to a position, having told it how big it is. */
    const scrollTo = (top: number) => {
      const list = screen.getByRole('listbox');
      for (const [name, value] of [
        ['scrollHeight', 1000],
        ['clientHeight', 300],
        ['scrollTop', top],
      ] as const) {
        Object.defineProperty(list, name, { configurable: true, value });
      }
      fireEvent.scroll(list);
    };

    const openList = async (prompts = many) => {
      picker({ prompts });
      await userEvent.click(screen.getByRole('button', { name: /Prompts/ }));
    };

    it('draws one page to begin with, and says how many are left', async () => {
      await openList();

      expect(rows()).toHaveLength(200);
      // The newest at the top, so the page drawn first is the recent end of the session.
      expect(said()[0]).toBe('prompt 459');
      expect(screen.getByText('260 older')).toBeTruthy();
    });

    it('draws the next page on reaching the bottom', async () => {
      await openList();

      scrollTo(700);

      expect(rows()).toHaveLength(400);
      expect(screen.getByText('60 older')).toBeTruthy();
    });

    it('keeps going until there are none left', async () => {
      await openList();

      scrollTo(700);
      scrollTo(700);

      expect(rows()).toHaveLength(460);
      // And the oldest is where scrolling to the end of the list arrives.
      expect(said()[459]).toBe('prompt 0');
      expect(screen.queryByText(/older/)).toBeNull();
    });

    /** Scrolling within the page is reading it, not asking for more. */
    it('draws no more while there is still page to scroll', async () => {
      await openList();

      scrollTo(300);

      expect(rows()).toHaveLength(200);
    });

    /** Narrowing puts a different list under the reader, who is back at the top of it. */
    it('goes back to one page when the filter changes', async () => {
      await openList();
      scrollTo(700);
      expect(rows()).toHaveLength(400);

      await userEvent.type(screen.getByRole('searchbox'), 'prompt');

      expect(rows()).toHaveLength(200);
    });

    /** The oldest is past the first page, so this only finds it if the filter reaches past it. */
    it('reaches the rest through the filter as well', async () => {
      await openList();
      await userEvent.type(screen.getByRole('searchbox'), 'prompt 0');

      expect(said()).toEqual(['prompt 0']);
      expect(screen.queryByText(/older/)).toBeNull();
    });
  });
});
