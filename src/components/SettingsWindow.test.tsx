// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsWindow } from './SettingsWindow';
import type { Settings } from '../lib/useSettings';

afterEach(cleanup);

const DEFAULTS: Settings = { maxLoaded: 0, idleMinutes: 10, confirmDelete: true };

const show = (over: Partial<Settings> = {}) => {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(<SettingsWindow settings={{ ...DEFAULTS, ...over }} onChange={onChange} onClose={onClose} />);
  return { onChange, onClose };
};

const kept = () => screen.getByLabelText('Sessions kept in memory') as HTMLInputElement;
const idle = () => screen.getByLabelText('Release an idle session after') as HTMLInputElement;
const asks = () => screen.getByLabelText('Ask before deleting a session') as HTMLInputElement;

describe('the settings window', () => {
  it('shows what each setting is now', () => {
    show({ maxLoaded: 3, idleMinutes: 25, confirmDelete: false });

    expect(kept().value).toBe('3');
    expect(idle().value).toBe('25');
    expect(asks().checked).toBe(false);
  });

  it('changes how many sessions are kept', async () => {
    const { onChange } = show({ maxLoaded: 0 });

    await userEvent.type(kept(), '4');

    expect(onChange).toHaveBeenCalledWith('maxLoaded', 4);
  });

  it('changes how long an idle one is kept', async () => {
    const { onChange } = show({ idleMinutes: 1 });

    await userEvent.type(idle(), '5');

    expect(onChange).toHaveBeenCalledWith('idleMinutes', 15);
  });

  /**
   * The reason this window exists at all. Ticking "do not ask again" on a delete turned the
   * confirmation off with no way back except editing a file by hand, on the one action in
   * the app that destroys something.
   */
  it('turns the delete confirmation back on', async () => {
    const { onChange } = show({ confirmDelete: false });

    await userEvent.click(asks());

    expect(onChange).toHaveBeenCalledExactlyOnceWith('confirmDelete', true);
  });

  it('turns it off as well, since a one-way door in either direction is one', async () => {
    const { onChange } = show({ confirmDelete: true });

    await userEvent.click(asks());

    expect(onChange).toHaveBeenCalledExactlyOnceWith('confirmDelete', false);
  });

  // Both are counts of things, and a negative one would mean nothing to the runtime.
  it.each([
    ['Sessions kept in memory', kept],
    ['Release an idle session after', idle],
  ])('refuses a negative %s', async (_label, field) => {
    const { onChange } = show();

    fireEvent.change(field(), { target: { value: '-5' } });

    expect(onChange).toHaveBeenCalledWith(expect.any(String), 0);
  });

  it('rounds a fraction down, since half a session is not a session', () => {
    const { onChange } = show();

    fireEvent.change(kept(), { target: { value: '2.7' } });

    expect(onChange).toHaveBeenCalledWith('maxLoaded', 2);
  });

  it('reads an emptied box as none rather than as nothing', () => {
    const { onChange } = show({ maxLoaded: 3 });

    fireEvent.change(kept(), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith('maxLoaded', 0);
  });

  // Zero is a real answer for both, and means opposite things, so it has to say which.
  it('says what zero means for each', () => {
    show({ maxLoaded: 0, idleMinutes: 0 });

    expect(screen.getByText(/No limit/)).toBeTruthy();
    expect(screen.getByText(/^Never\./)).toBeTruthy();
  });

  it('says what a number means rather than leaving it bare', () => {
    show({ maxLoaded: 3, idleMinutes: 1 });

    expect(screen.getByText(/Past 3, the least recently used is released/)).toBeTruthy();
    expect(screen.getByText(/1 minute\. The default is 10\./)).toBeTruthy();
  });

  describe('closing it', () => {
    beforeEach(() => cleanup());

    it('closes on Done', async () => {
      const { onClose } = show();
      await userEvent.click(screen.getByText('Done'));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('closes on Escape', () => {
      const { onClose } = show();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('closes on a click outside', () => {
      const { onClose } = show();
      fireEvent.mouseDown(document.querySelector('.confirm-backdrop') as HTMLElement);
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('stays open when the pointer goes down on the window itself', () => {
      const { onClose } = show();
      fireEvent.mouseDown(screen.getByRole('dialog'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
