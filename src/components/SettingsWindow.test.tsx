// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsWindow } from './SettingsWindow';
import type { Settings } from '../lib/useSettings';

afterEach(cleanup);

const SAVED: Settings = { maxLoaded: 0, idleMinutes: 10, confirmDelete: true };

const show = (over: Partial<Settings> = {}) => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<SettingsWindow settings={{ ...SAVED, ...over }} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose };
};

const kept = () => screen.getByLabelText('Sessions kept in memory') as HTMLInputElement;
const idle = () => screen.getByLabelText('Release an idle session after') as HTMLInputElement;
const asks = () => screen.getByLabelText('Ask before deleting a session') as HTMLInputElement;
const commit = () => screen.getByRole('button', { name: /Save|Done/ });

describe('the settings window', () => {
  it('shows what each setting is now', () => {
    show({ maxLoaded: 3, idleMinutes: 25, confirmDelete: false });

    expect(kept().value).toBe('3');
    expect(idle().value).toBe('25');
    expect(asks().checked).toBe(false);
  });

  it('shows what has been typed before it is saved', async () => {
    show({ maxLoaded: 0 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '4');

    expect(kept().value).toBe('4');
  });
});

/**
 * Nothing takes effect until it is saved. Half-typed numbers are why: a field being cleared
 * to type 25 into passes through empty, and applying as it is typed would release every
 * session in memory on the way past.
 */
describe('saving', () => {
  it('changes nothing while a number is being typed', async () => {
    const { onSave } = show({ maxLoaded: 0 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '25');

    expect(onSave).not.toHaveBeenCalled();
  });

  it('changes nothing while a box is being ticked', async () => {
    const { onSave } = show();

    await userEvent.click(asks());

    expect(onSave).not.toHaveBeenCalled();
  });

  it('applies everything at once when saved', async () => {
    const { onSave, onClose } = show({ maxLoaded: 0, idleMinutes: 10, confirmDelete: true });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '3');
    await userEvent.clear(idle());
    await userEvent.type(idle(), '25');
    await userEvent.click(asks());
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith({ maxLoaded: 3, idleMinutes: 25, confirmDelete: false });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers to save only once something has been changed', async () => {
    show({ maxLoaded: 0 });
    expect(screen.getByText('Done')).toBeTruthy();

    await userEvent.clear(kept());
    await userEvent.type(kept(), '2');

    expect(screen.getByText('Save')).toBeTruthy();
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('goes back to Done when a change is typed back out again', async () => {
    show({ maxLoaded: 3 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '4');
    expect(screen.getByText('Save')).toBeTruthy();

    await userEvent.clear(kept());
    await userEvent.type(kept(), '3');

    expect(screen.getByText('Done')).toBeTruthy();
  });

  // Nothing changed is not nothing to do: the window still has to close.
  it('closes on Done when nothing was changed', async () => {
    const { onClose } = show();

    await userEvent.click(screen.getByText('Done'));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('leaving without saving', () => {
  it('keeps what was saved, whatever was typed', async () => {
    const { onSave, onClose } = show({ maxLoaded: 3 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');
    await userEvent.click(screen.getByText('Cancel'));

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('forgets what was typed, so opening it again starts from what is saved', async () => {
    const { onClose } = show({ maxLoaded: 3 });
    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');
    await userEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();

    // Closing unmounts the window, so opening it again is a fresh one.
    cleanup();
    show({ maxLoaded: 3 });

    expect(kept().value).toBe('3');
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['a click outside', () => fireEvent.mouseDown(document.querySelector('.confirm-backdrop') as HTMLElement)],
  ])('discards on %s, as Cancel does', async (_what, leave) => {
    const { onSave, onClose } = show({ maxLoaded: 3 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');
    leave();

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open when the pointer goes down on the window itself', () => {
    const { onClose } = show();

    fireEvent.mouseDown(screen.getByRole('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('what a number may be', () => {
  const more = (label: string) => screen.getByLabelText(`More ${label.toLowerCase()}`);
  const fewer = (label: string) => screen.getByLabelText(`Fewer ${label.toLowerCase()}`);

  /**
   * The steppers are this app's own. The native ones came out as a pale strip at the edge
   * of a dark field, so they are hidden and drawn here instead.
   */
  it('counts up and down from the steppers', async () => {
    show({ maxLoaded: 3 });

    await userEvent.click(more('Sessions kept in memory'));
    expect(kept().value).toBe('4');

    await userEvent.click(fewer('Sessions kept in memory'));
    await userEvent.click(fewer('Sessions kept in memory'));
    expect(kept().value).toBe('2');
  });

  it('names each stepper after what it changes, since there are two pairs', () => {
    show();

    expect(more('Sessions kept in memory')).toBeTruthy();
    expect(more('Release an idle session after')).toBeTruthy();
  });

  it('steps the field it belongs to and leaves the other alone', async () => {
    show({ maxLoaded: 3, idleMinutes: 10 });

    await userEvent.click(more('Release an idle session after'));

    expect(idle().value).toBe('11');
    expect(kept().value).toBe('3');
  });

  it('stops at zero rather than going below it', async () => {
    show({ maxLoaded: 0 });

    expect((fewer('Sessions kept in memory') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(fewer('Sessions kept in memory'));

    expect(kept().value).toBe('0');
  });

  it('needs saving like anything else typed', async () => {
    const { onSave } = show({ maxLoaded: 3 });

    await userEvent.click(more('Sessions kept in memory'));
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.click(commit());
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxLoaded: 4 }));
  });

  // Both are counts of things, and a negative one would mean nothing to the runtime.
  it.each([
    ['Sessions kept in memory', kept],
    ['Release an idle session after', idle],
  ])('refuses a negative %s', (_label, field) => {
    show();

    fireEvent.change(field(), { target: { value: '-5' } });

    expect(field().value).toBe('0');
  });

  it('rounds a fraction down, since half a session is not a session', () => {
    show();

    fireEvent.change(kept(), { target: { value: '2.7' } });

    expect(kept().value).toBe('2');
  });

  it('reads an emptied box as none rather than as nothing', () => {
    show({ maxLoaded: 3 });

    fireEvent.change(kept(), { target: { value: '' } });

    expect(kept().value).toBe('0');
  });
});

describe('saying what a setting means', () => {
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

  // The note describes the draft, or it would explain a setting that is not on screen.
  it('follows what has been typed rather than what is saved', async () => {
    show({ maxLoaded: 0 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '2');

    expect(screen.getByText(/Past 2, the least recently used is released/)).toBeTruthy();
    expect(screen.queryByText(/No limit/)).toBeNull();
  });
});
