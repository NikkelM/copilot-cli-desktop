// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FindBar } from './FindBar';

afterEach(cleanup);

const show = (over: Partial<Parameters<typeof FindBar>[0]> = {}) => {
  const onQuery = vi.fn();
  const onStep = vi.fn();
  const onClose = vi.fn();
  const onSearchAll = vi.fn();
  const props = {
    query: '',
    onQuery,
    said: 0,
    at: -1,
    onStep,
    onClose,
    openedAt: 1,
    searchAll: true,
    onSearchAll,
    reaching: false,
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
    onClose,
    onSearchAll,
    again: (next: Partial<Parameters<typeof FindBar>[0]>) =>
      rerender(
        <ol>
          <FindBar {...props} {...next} />
        </ol>,
      ),
  };
};

const field = () => screen.getByLabelText('Find in this session') as HTMLInputElement;

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

    expect(screen.getByRole('status').textContent).toBe('3 of 17');
  });

  it('says so when the words are nowhere', () => {
    show({ query: 'fox', said: 0 });

    expect(screen.getByRole('status').textContent).toBe('Nothing here');
  });

  it('says nothing at all before anything is typed', () => {
    show({ query: '' });

    expect(screen.getByRole('status').textContent).toBe('');
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

    expect(screen.getByRole('status').textContent).toBe('1 of 4 shown');
  });

  it('claims the whole session once it has reached back', () => {
    show({ query: 'fox', said: 4, at: 0, searchAll: true });

    expect(screen.getByRole('status').textContent).toBe('1 of 4');
  });

  /** What it has while it is still reading is a floor rather than a total. */
  it('says it is still counting while it reaches', () => {
    show({ query: 'fox', said: 4, at: 0, searchAll: true, reaching: true });

    expect(screen.getByRole('status').textContent).toBe('1 of 4 so far');
  });

  it('does not call it empty while there is still more to read', () => {
    show({ query: 'fox', said: 0, searchAll: true, reaching: true });

    expect(screen.getByRole('status').textContent).toBe('0 of 0 so far');
    expect((screen.getByLabelText('Find in this session') as HTMLInputElement).className).not.toContain('empty');
  });
});
