// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsWindow } from './SettingsWindow';
import type { Settings } from '../lib/useSettings';

afterEach(cleanup);

const SAVED: Settings = {
  maxLoaded: 0,
  idleMinutes: 10,
  confirmDelete: true,
  allowAll: false,
  workingDirectory: '',
  updateOnStart: false,
};

const show = (over: Partial<Settings> = {}) => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const settings = { ...SAVED, ...over };
  const { rerender } = render(<SettingsWindow settings={settings} onSave={onSave} onClose={onClose} />);

  /** What the app does after a save: hands back the settings it now holds. */
  const saved = (next: Settings) =>
    rerender(<SettingsWindow settings={next} onSave={onSave} onClose={onClose} />);

  return { onSave, onClose, saved };
};

const kept = () => screen.getByLabelText('Sessions kept in memory') as HTMLInputElement;
const idle = () => screen.getByLabelText('Release an idle session after') as HTMLInputElement;
const asks = () => screen.getByLabelText('Ask before deleting a session') as HTMLInputElement;
const commit = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const leaveButton = () => screen.getByRole('button', { name: /^(Cancel|Close)$/ });
const tab = (name: string) => screen.getByRole('button', { name });

describe('the settings window', () => {
  it('opens on the first category', () => {
    show();

    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Session management');
    expect(kept()).toBeTruthy();
  });

  it('shows only the settings of the category being looked at', async () => {
    show();
    // The memory settings and the delete question are one category, so both are here.
    expect(kept()).toBeTruthy();
    expect(asks()).toBeTruthy();
    expect(screen.queryByLabelText('Run tools without asking')).toBeNull();

    await userEvent.click(tab('New sessions'));

    expect(screen.getByLabelText('Run tools without asking')).toBeTruthy();
    expect(screen.queryByLabelText('Sessions kept in memory')).toBeNull();
    expect(screen.queryByLabelText('Ask before deleting a session')).toBeNull();
  });

  it('says which category is being looked at', async () => {
    show();
    expect(tab('Session management').getAttribute('aria-current')).toBe('true');

    await userEvent.click(tab('New sessions'));

    expect(tab('New sessions').getAttribute('aria-current')).toBe('true');
    expect(tab('Session management').getAttribute('aria-current')).toBe('false');
  });

  /** One category, but two ideas in it, and each says which it is. */
  it('names the groups within a category that holds more than one idea', () => {
    show();

    const names = [...document.querySelectorAll('.settings-subhead')].map((node) => node.textContent);
    expect(names).toEqual(['Memory', 'Deleting']);
  });

  it('shows what each setting is now', async () => {
    show({ maxLoaded: 3, idleMinutes: 25, confirmDelete: false });

    expect(kept().value).toBe('3');
    expect(idle().value).toBe('25');

    expect(asks().checked).toBe(false);
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

  it('applies what was changed when saved', async () => {
    const { onSave } = show({ maxLoaded: 0, idleMinutes: 10 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '3');
    await userEvent.clear(idle());
    await userEvent.type(idle(), '25');
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...SAVED, maxLoaded: 3, idleMinutes: 25 });
  });

  /**
   * Saving and leaving are separate decisions. A window that shut itself on saving left no
   * way to keep a change and carry on looking at the rest.
   */
  it('stays open after saving', async () => {
    const { onClose } = show({ maxLoaded: 0 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '3');
    await userEvent.click(commit());

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('has nothing left to save once it is saved', async () => {
    const { saved } = show({ maxLoaded: 0 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '3');
    expect(commit().disabled).toBe(false);

    saved({ ...SAVED, maxLoaded: 3 });

    expect(commit().disabled).toBe(true);
    expect(kept().value).toBe('3');
  });

  it('can be saved again after another change', async () => {
    const { onSave, saved } = show({ maxLoaded: 0 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '3');
    await userEvent.click(commit());
    saved({ ...SAVED, maxLoaded: 3 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '5');
    await userEvent.click(commit());

    expect(onSave).toHaveBeenLastCalledWith({ ...SAVED, maxLoaded: 5 });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('offers nothing to save until something has been changed', async () => {
    show({ maxLoaded: 0 });
    expect(commit().disabled).toBe(true);

    await userEvent.clear(kept());
    await userEvent.type(kept(), '2');

    expect(commit().disabled).toBe(false);
  });

  it('goes back to nothing to save when a change is typed back out again', async () => {
    show({ maxLoaded: 3 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '4');
    expect(commit().disabled).toBe(false);

    await userEvent.clear(kept());
    await userEvent.type(kept(), '3');

    expect(commit().disabled).toBe(true);
  });

  /** The word changes with what it does: there is nothing to cancel until there is. */
  it('says Close when there is nothing to discard, and Cancel when there is', async () => {
    show({ maxLoaded: 3 });
    expect(leaveButton().textContent).toBe('Close');

    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');

    expect(leaveButton().textContent).toBe('Cancel');
  });

  it('closes on Close when nothing was changed', async () => {
    const { onClose } = show();

    await userEvent.click(leaveButton());

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('discards and closes on Cancel, without asking', async () => {
    const { onSave, onClose } = show({ maxLoaded: 3 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');
    await userEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/**
 * Leaving with something changed is stopped and asked about, wherever the leaving was
 * headed. Cancel is the exception: discarding is what it is for, and asking would be
 * asking twice.
 */
describe('leaving with something unsaved', () => {
  const dirty = async (over: Partial<Settings> = {}) => {
    const harness = show({ maxLoaded: 3, ...over });
    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');
    return harness;
  };

  const asked = () => screen.queryByRole('alertdialog');
  /** Scoped to the question, since the window behind it has a Save of its own. */
  const answer = (label: string) => userEvent.click(within(screen.getByRole('alertdialog')).getByText(label));

  it.each([
    ['another category', () => userEvent.click(tab('New sessions'))],
    ['the close button', () => userEvent.click(screen.getByLabelText('Close settings'))],
    ['a click outside', async () => fireEvent.mouseDown(document.querySelector('.confirm-backdrop') as HTMLElement)],
    ['Escape', async () => fireEvent.keyDown(window, { key: 'Escape' })],
  ])('asks before leaving for %s', async (_what, leave) => {
    const { onSave, onClose } = await dirty();

    await leave();

    expect(asked()).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('goes nowhere while the question is open', async () => {
    await dirty();

    await userEvent.click(tab('New sessions'));

    // Still on Memory, and still showing what was typed.
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Session management');
    expect(kept().value).toBe('9');
  });

  it('carries on to the category once it is saved', async () => {
    const { onSave } = await dirty();
    await userEvent.click(tab('New sessions'));

    await answer('Save');

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxLoaded: 9 }));
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('New sessions');
    expect(asked()).toBeNull();
  });

  it('carries on to the category once it is discarded, keeping what was saved', async () => {
    const { onSave } = await dirty();
    await userEvent.click(tab('New sessions'));

    await answer('Discard');

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('New sessions');

    // And going back shows what was saved rather than what was typed.
    await userEvent.click(tab('Session management'));
    expect(kept().value).toBe('3');
  });

  it('closes once the question about closing is answered', async () => {
    const { onSave, onClose } = await dirty();
    await userEvent.click(screen.getByLabelText('Close settings'));

    await answer('Save');

    expect(onSave).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays put when the question is answered with Keep editing', async () => {
    const { onSave, onClose } = await dirty();
    await userEvent.click(tab('New sessions'));

    await answer('Keep editing');

    expect(asked()).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(kept().value).toBe('9');
  });

  /** Or Escape would close the window out from under the question it had just raised. */
  it('answers the question with Escape before closing anything', async () => {
    const { onClose } = await dirty();
    await userEvent.click(tab('New sessions'));

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(asked()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(kept().value).toBe('9');
  });

  it('asks nothing when there is nothing to lose', async () => {
    const { onClose } = show();

    await userEvent.click(tab('New sessions'));
    expect(asked()).toBeNull();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('New sessions');

    await userEvent.click(screen.getByLabelText('Close settings'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('asks about a change made in either category', async () => {
    show();
    await userEvent.click(asks());
    await userEvent.click(tab('Session management'));

    expect(asked()).toBeTruthy();
  });
});

/**
 * What a session starts with. None of these could be given to the CLI as arguments: the
 * shared server takes `--allow-all` and the sessions it creates still come back asking,
 * because the flag configures the process and the mode belongs to the session (#199).
 */
describe('the defaults a new session starts with', () => {
  const openSessions = () => userEvent.click(tab('New sessions'));

  it('offers running tools without asking, off to begin with', async () => {
    show();
    await openSessions();

    const box = screen.getByLabelText('Run tools without asking') as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it('saves it with everything else', async () => {
    const { onSave } = show();
    await openSessions();

    await userEvent.click(screen.getByLabelText('Run tools without asking'));
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allowAll: true }));
  });

  // The names are the CLI's own, and they are the same flag, so saying so saves looking.
  it('says what it is the same as', async () => {
    show({ allowAll: true });
    await openSessions();

    expect(screen.getByText(/--allow-all and --yolo, which are the same flag/)).toBeTruthy();
  });

  it('takes a directory to start sessions in', async () => {
    const { onSave } = show();
    await openSessions();

    await userEvent.type(screen.getByLabelText('Working directory'), 'F:\\work');
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workingDirectory: 'F:\\work' }));
  });

  // Empty is a real answer rather than a missing one, and it is the one that ships.
  it('says what an empty directory means rather than leaving it blank', async () => {
    show();
    await openSessions();

    expect((screen.getByLabelText('Working directory') as HTMLInputElement).placeholder).toBe(
      'Your home directory',
    );
  });
});

describe('keeping the CLI up to date', () => {
  const openCli = () => userEvent.click(tab('Copilot CLI'));

  /**
   * Off to begin with, because it is the app's habit that changed rather than the CLI's:
   * the SDK spawns the CLI with `--no-auto-update` every time, so it never updates itself
   * here however it is configured elsewhere.
   */
  it('is off until it is asked for', async () => {
    show();
    await openCli();

    expect((screen.getByLabelText('Update the CLI when the app starts') as HTMLInputElement).checked).toBe(false);
  });

  it('saves it', async () => {
    const { onSave } = show();
    await openCli();

    await userEvent.click(screen.getByLabelText('Update the CLI when the app starts'));
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ updateOnStart: true }));
  });

  it('says why it exists, since the CLI is supposed to do this itself', async () => {
    show({ updateOnStart: false });
    await openCli();

    expect(screen.getByText(/never when this app launches it/)).toBeTruthy();
  });
});

describe('the tick box', () => {
  const tick = () => document.querySelector('.tickbox .tick') as SVGElement | null;

  /**
   * Drawn beside the box rather than in it: a pseudo-element on an input is not something
   * every engine renders, and the native box arrives in its own blue either way.
   */
  it('draws its own tick rather than leaving it to the browser', async () => {
    show({ confirmDelete: true });
    expect(tick()).not.toBeNull();
    expect(asks().type).toBe('checkbox');
  });

  it('keeps the tick beside the box it belongs to, so the styling can find it', async () => {
    show({ confirmDelete: true });
    // The rule that shows it is `input:checked + .tick`, which only holds while they are
    // siblings in that order.
    expect(asks().nextElementSibling).toBe(tick());
  });

  it('ticks when its own text is clicked', async () => {
    show({ confirmDelete: false });
    await userEvent.click(screen.getByText('Ask before deleting a session'));

    expect(asks().checked).toBe(true);
  });

  /**
   * The note explains the setting rather than offering it again. Reaching it used to
   * change it, which is easy to do by accident while reading.
   */
  it('does not tick when the note under it is clicked', async () => {
    show({ confirmDelete: false });
    await userEvent.click(screen.getByText(/Deleting removes the transcript/));

    expect(asks().checked).toBe(false);
  });

  it('keeps the note out of what can be clicked', async () => {
    show({ confirmDelete: false });
    expect(screen.getByText(/Deleting removes the transcript/).closest('label')).toBeNull();
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
