// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FindBar } from './FindBar';
import { PLAIN } from '../lib/findMode';

afterEach(cleanup);

const show = (over: Partial<Parameters<typeof FindBar>[0]> = {}) => {
  const onQuery = vi.fn();
  const onStep = vi.fn();
  const onClose = vi.fn();
  const onSearchAll = vi.fn();
  const onGo = vi.fn();
  const onMode = vi.fn();
  const props = {
    query: '',
    onQuery,
    said: 0,
    at: -1,
    onStep,
    onGo,
    onClose,
    openedAt: 1,
    searchAll: true,
    onSearchAll,
    reaching: false,
    mode: PLAIN,
    onMode,
    ...over,
  };
  const { rerender } = render(
    <ol>
      <FindBar {...props} />
    </ol>,
  );

  return {
    onQuery,
    onStep,
    onGo,
    onClose,
    onSearchAll,
    onMode,
    again: (next: Partial<Parameters<typeof FindBar>[0]>) =>
      rerender(
        <ol>
          <FindBar {...props} {...next} />
        </ol>,
      ),
  };
};

const field = () => screen.getByLabelText('Find in this session') as HTMLInputElement;

/**
 * The whole sentence the bar is saying, box and all.
 *
 * The number is a field now, so it has no text of its own to read - and a reader sees one
 * sentence rather than a control wedged into a label.
 */
const count = () => {
  const box = screen.queryByRole('textbox', { name: /^Match/ }) as HTMLInputElement | null;
  const rest = screen.getByRole('status').textContent ?? '';
  return box ? `${box.value}${rest}` : rest;
};

describe('the find bar', () => {
  it('takes the keyboard as it opens', () => {
    show();

    expect(document.activeElement).toBe(field());
  });

  /** Pressing the key again means "put me back in the box", not "open another one". */
  it('takes it again when the key is pressed again', () => {
    const { again } = show({ query: 'fox' });
    field().blur();

    again({ openedAt: 2 });

    expect(document.activeElement).toBe(field());
  });

  it('selects what is there, so the next thing typed replaces it', () => {
    show({ query: 'fox' });

    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe(3);
  });

  it('reports what is typed', async () => {
    const { onQuery } = show();

    await userEvent.type(field(), 'f');

    expect(onQuery).toHaveBeenCalledWith('f');
  });

  /**
   * The transcript holds what it has read rather than the whole session, so a bare number
   * would be a claim about the conversation that is not true.
   */
  it('says what it is counting', () => {
    show({ query: 'fox', said: 17, at: 2 });

    expect(count()).toBe('3 of 17');
  });

  it('says so when the words are nowhere', () => {
    show({ query: 'fox', said: 0 });

    expect(count()).toBe('Nothing here');
  });

  it('says nothing at all before anything is typed', () => {
    show({ query: '' });

    expect(count()).toBe('');
  });

  it('walks forward on Enter', async () => {
    const { onStep } = show({ query: 'fox', said: 3, at: 0 });

    await userEvent.keyboard('{Enter}');

    expect(onStep).toHaveBeenCalledWith(1);
  });

  it('walks back on shift+Enter', async () => {
    const { onStep } = show({ query: 'fox', said: 3, at: 1 });

    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onStep).toHaveBeenCalledWith(-1);
  });

  it.each([
    ['Next match', 1],
    ['Previous match', -1],
  ])('walks on the %s button', async (name, by) => {
    const { onStep } = show({ query: 'fox', said: 3, at: 0 });

    await userEvent.click(screen.getByRole('button', { name }));

    expect(onStep).toHaveBeenCalledWith(by);
  });

  it('offers nothing to walk when there is nothing to walk to', () => {
    show({ query: 'fox', said: 0 });

    expect((screen.getByRole('button', { name: 'Next match' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes on Escape', async () => {
    const { onClose } = show({ query: 'fox' });

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  /**
   * Escape belongs to the bar while the bar has the keyboard. The composer behind it would
   * otherwise clear what was being written, which is not what closing a find box means.
   */
  it('keeps Escape from reaching what is behind it', async () => {
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    show({ query: 'fox' });

    await userEvent.keyboard('{Escape}');

    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener('keydown', heard);
  });

  it('closes on the button too', async () => {
    const { onClose } = show({ query: 'fox' });

    await userEvent.click(screen.getByRole('button', { name: 'Close find' }));

    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * Whether the find reaches back for the rest of the session, or only looks at what the
 * transcript already holds (#209).
 */
describe('reaching back for the rest', () => {
  const toggle = () => screen.getByRole('checkbox', { name: /Entire session/ }) as HTMLInputElement;

  it('is on unless it was turned off', () => {
    show();

    expect(toggle().checked).toBe(true);
  });

  it('reports being turned off', async () => {
    const { onSearchAll } = show({ searchAll: true });

    await userEvent.click(toggle());

    expect(onSearchAll).toHaveBeenCalledWith(false);
  });

  it('reports being turned back on', async () => {
    const { onSearchAll } = show({ searchAll: false });

    await userEvent.click(toggle());

    expect(onSearchAll).toHaveBeenCalledWith(true);
  });

  /** A box answers Space and nothing else, which surprises beside controls that take Enter. */
  it('takes Enter as well as Space', async () => {
    const { onSearchAll } = show({ searchAll: true });
    toggle().focus();

    await userEvent.keyboard('{Enter}');

    expect(onSearchAll).toHaveBeenCalledWith(false);
  });

  /** The page is not the session, so a count over it has to say which it means. */
  it('says the count is only what is shown while the reach is off', () => {
    show({ query: 'fox', said: 4, at: 0, searchAll: false });

    expect(count()).toBe('1 of 4 shown');
  });
  it('claims the whole session once it has reached back', () => {
    show({ query: 'fox', said: 4, at: 0, searchAll: true });

    expect(count()).toBe('1 of 4');
  });

  /** What it has while it is still reading is a floor rather than a total. */
  it('says it is still counting while it reaches', () => {
    show({ query: 'fox', said: 4, at: 0, searchAll: true, reaching: true });

    expect(count()).toBe('1 of 4 so far');
  });

  it('does not call it empty while there is still more to read', () => {
    show({ query: 'fox', said: 0, searchAll: true, reaching: true });

    expect(count()).toBe('0 of 0 so far');
    expect((screen.getByLabelText('Find in this session') as HTMLInputElement).className).not.toContain('empty');
  });
});

/**
 * Typing the number to jump to it (#209).
 *
 * Walking to the fortieth of two hundred is forty presses otherwise, and the number is
 * already on screen saying where the reader is - so it is the obvious thing to type into.
 */
describe('going straight to a hit', () => {
  const number = () => screen.getByRole('textbox', { name: /^Match/ }) as HTMLInputElement;

  it('shows which hit the reader is on', () => {
    show({ query: 'fox', said: 21, at: 2 });

    expect(number().value).toBe('3');
  });

  it('jumps as the number is typed', async () => {
    const { onGo } = show({ query: 'fox', said: 21, at: 0 });

    await userEvent.clear(number());
    await userEvent.type(number(), '7');

    expect(onGo).toHaveBeenLastCalledWith(6);
  });

  /** Counted from one on screen and from zero underneath, which is where that is settled. */
  it('counts from one, as the sentence it sits in does', async () => {
    const { onGo } = show({ query: 'fox', said: 21, at: 0 });

    await userEvent.clear(number());
    await userEvent.type(number(), '1');

    expect(onGo).toHaveBeenLastCalledWith(0);
  });

  it('takes a number of more than one digit', async () => {
    const { onGo } = show({ query: 'fox', said: 21, at: 0 });

    await userEvent.clear(number());
    await userEvent.type(number(), '12');

    expect(onGo).toHaveBeenLastCalledWith(11);
  });

  /**
   * A digit typed onto the end of a number that was already large is a reader reaching for
   * the far end, so take them there: typing 5 after the 2 of 22 means the last one.
   */
  it('clamps a number past the end to the last hit', async () => {
    const { onGo } = show({ query: 'fox', said: 22, at: 1 });

    await userEvent.click(number());
    await userEvent.type(number(), '5');

    expect(onGo).toHaveBeenLastCalledWith(21);
    expect(number().value, 'and says where it took them').toBe('22');
  });

  it('clamps a number below the first to the first', async () => {
    const { onGo } = show({ query: 'fox', said: 22, at: 4 });

    await userEvent.clear(number());
    await userEvent.type(number(), '0');

    expect(onGo).toHaveBeenLastCalledWith(0);
    expect(number().value).toBe('1');
  });

  /** Nothing that is not a number names a hit, and the box should not hold one either. */
  it('ignores anything that is not a number', async () => {
    const { onGo } = show({ query: 'fox', said: 22, at: 4 });

    await userEvent.type(number(), 'x');

    expect(onGo).not.toHaveBeenCalled();
    expect(number().value).toBe('5');
  });

  it('can be cleared on the way to typing another number', async () => {
    const { onGo } = show({ query: 'fox', said: 22, at: 4 });

    await userEvent.clear(number());

    expect(number().value).toBe('');
    expect(onGo, 'an empty box names no hit either').not.toHaveBeenCalled();
  });
  /** A half-typed number that went nowhere should not be left standing in the sentence. */
  /** An empty box names no hit, so leaving one should put the sentence back together. */
  it('goes back to saying where the reader is when it is left', async () => {
    show({ query: 'fox', said: 21, at: 4 });
    await userEvent.clear(number());

    await userEvent.tab();

    expect(number().value).toBe('5');
  });

  it.each([
    ['{ArrowDown}', 1],
    ['{ArrowUp}', -1],
  ])('walks on %s, as the arrows do everywhere', async (key, by) => {
    const { onStep } = show({ query: 'fox', said: 21, at: 4 });
    number().focus();

    await userEvent.keyboard(key);

    expect(onStep).toHaveBeenCalledWith(by);
  });

  it('closes the bar on Escape, as the box beside it does', async () => {
    const { onClose } = show({ query: 'fox', said: 21, at: 4 });
    number().focus();

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  /** Nothing to go to, so there is nothing to type into either. */
  it('is not there when nothing was found', () => {
    show({ query: 'fox', said: 0 });

    expect(screen.queryByRole('textbox', { name: /^Match/ })).toBeNull();
  });

  /** Three toggles sit between the words and the number, which Tab walks through on its way. */
  it('is reachable by keyboard from the words being searched for', async () => {
    show({ query: 'fox', said: 21, at: 0 });
    screen.getByLabelText('Find in this session').focus();

    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();

    expect(document.activeElement).toBe(number());
  });
});

/**
 * The three toggles, as the glyphs a reader knows them by from everywhere else (#209).
 */
describe('how the words are matched', () => {
  const mode = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

  it.each(['Match case', 'Match whole word', 'Use a regular expression'])('offers %s', (name) => {
    show({ query: 'fox' });

    expect(mode(name)).toBeTruthy();
  });

  it('says which are on', () => {
    show({ query: 'fox', mode: { matchCase: true, wholeWord: false, regex: false } });

    expect(mode('Match case').getAttribute('aria-pressed')).toBe('true');
    expect(mode('Use a regular expression').getAttribute('aria-pressed')).toBe('false');
  });

  it.each([
    ['Match case', 'matchCase'],
    ['Match whole word', 'wholeWord'],
    ['Use a regular expression', 'regex'],
  ])('turns %s on', async (name, key) => {
    const { onMode } = show({ query: 'fox' });

    await userEvent.click(mode(name));

    expect(onMode).toHaveBeenCalledWith({ [key]: true });
  });

  it('turns one back off', async () => {
    const { onMode } = show({ query: 'fox', mode: { matchCase: true, wholeWord: false, regex: false } });

    await userEvent.click(mode('Match case'));

    expect(onMode).toHaveBeenCalledWith({ matchCase: false });
  });

  /** A pattern nobody can use is a mistake in the box, not a search that found nothing. */
  it('marks the box when the pattern will not compile', () => {
    show({ query: 'fox(', said: 3, mode: { matchCase: false, wholeWord: false, regex: true } });

    expect(screen.getByLabelText('Find in this session').closest('.find-box')?.className).toContain('empty');
  });

  it('leaves the box alone for the same letters read as letters', () => {
    show({ query: 'fox(', said: 3, mode: PLAIN });

    expect(screen.getByLabelText('Find in this session').closest('.find-box')?.className).not.toContain('empty');
  });
});
