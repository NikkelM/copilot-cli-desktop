// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsWindow } from './SettingsWindow';
import type { Settings } from '../lib/useSettings';
import type { BinnedSession, CliSetting } from '../../shared/protocol';
import type { CliSettingsState } from '../lib/useCliSettings';
import { save } from '../lib/store';

afterEach(cleanup);

const SAVED: Settings = {
  maxLoaded: 0,
  idleMinutes: 10,
  confirmDelete: true,
  binRetentionDays: 7,
  permissionMinutes: 5,
  allowAll: false,
  workingDirectory: '',
  updateOnStart: false,
  scale: 1,
  textScale: 1,
  defaultModel: '',
  defaultEffort: '',
  defaultContext: '',
    turnSummary: 'always',
  sidebarTags: true,
  sidebarPreviewLines: 2,
  shortcuts: '',
  };

const show = (over: Partial<Settings> = {}) => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const settings = { ...SAVED, ...over };
  const { rerender, unmount } = render(<SettingsWindow settings={settings} onSave={onSave} onClose={onClose} />);

  /** What the app does after a save: hands back the settings it now holds. */
  const saved = (next: Settings) =>
    rerender(<SettingsWindow settings={next} onSave={onSave} onClose={onClose} />);

  return { onSave, onClose, saved, unmount };
};

const kept = () => screen.getByLabelText('Sessions kept in memory') as HTMLInputElement;
const idle = () => screen.getByLabelText('Release an idle session after') as HTMLInputElement;
const asks = () => screen.getByLabelText('Ask before deleting a session') as HTMLInputElement;
const commit = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const done = () => screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
const leaveButton = () => screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
const tab = (name: string) => screen.getByRole('button', { name });

describe('the settings window', () => {
  it('opens on the first category', () => {
    show();

    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Session management');
    expect(kept()).toBeTruthy();
  });

  /**
   * And on the one it was left in after that.
   *
   * Somebody adjusting one thing usually adjusts the next thing beside it, and being
   * returned to the first category every time is a navigation they did not ask for.
   */
  describe('where it opens next time', () => {
    it('opens where it was left', async () => {
      const first = show();
      await userEvent.click(tab('Appearance'));
      first.unmount();

      show();

      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Appearance');
    });

    /** Where the reader is, not a setting they are editing: closing unsaved still counts. */
    it('remembers it without the window being saved', async () => {
      const first = show();
      await userEvent.click(tab('Transcript'));
      first.unmount();

      const { onSave } = show();

      expect(onSave).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Transcript');
    });

    it('falls back to the first category for a name it does not recognise', () => {
      save('sessions', 'settingsCategory', 'a-category-that-went-away');

      show();

      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Session management');
    });
  });

  it('shows only the settings of the category being looked at', async () => {
    show();
    // The memory settings and the delete question are one category, so both are here.
    expect(kept()).toBeTruthy();
    expect(asks()).toBeTruthy();
    expect(screen.queryByLabelText('Default working directory')).toBeNull();

    await userEvent.click(tab('New sessions'));

    expect(screen.getByLabelText('Default working directory')).toBeTruthy();
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
    expect(names).toEqual(['Memory', 'Waiting for you', 'Deleting', 'Recycle bin', 'Disk usage']);
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

  /** Nothing to put back and nothing to keep, so neither has anything to do. */
  it('leaves Cancel available with nothing to undo, since it is also the way out', async () => {
    show({ maxLoaded: 3 });

    expect(leaveButton().disabled).toBe(false);
  });

  it('greys out Save until something has been changed', async () => {
    show({ maxLoaded: 3 });
    expect(commit().disabled).toBe(true);

    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');

    expect(commit().disabled).toBe(false);
  });

  // The way out when there is nothing to decide, and the only button that both keeps and goes.
  it('closes on Done when nothing was changed', async () => {
    const { onSave, onClose } = show();

    await userEvent.click(done());

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('saves and closes on Done, without asking', async () => {
    const { onSave, onClose } = show({ maxLoaded: 3 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');
    await userEvent.click(done());

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxLoaded: 9 }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // Keeping a change and carrying on looking is the whole reason it is its own button.
  it('stays open on Save', async () => {
    const { onSave, onClose } = show({ maxLoaded: 3 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxLoaded: 9 }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('discards and closes on Cancel, without asking', async () => {    const { onSave, onClose } = show({ maxLoaded: 3 });

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

  it('takes a directory to start sessions in', async () => {
    const { onSave } = show();
    await openSessions();

    await userEvent.type(screen.getByLabelText('Default working directory'), 'F:\\work');
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workingDirectory: 'F:\\work' }));
  });

  /**
   * Typed, pasted or picked. A path is the one setting here that is long enough to be worth
   * pasting and specific enough to be worth choosing, so it takes both (#173).
   */
  it('takes one from the folder picker as well as from the keyboard', async () => {
    const onPickDirectory = vi.fn(async () => 'F:\\picked');
    render(
      <SettingsWindow settings={SAVED} onSave={vi.fn()} onClose={vi.fn()} onPickDirectory={onPickDirectory} />,
    );
    await openSessions();

    await userEvent.click(screen.getByLabelText('Choose a working directory'));

    await vi.waitFor(() =>
      expect((screen.getByLabelText('Default working directory') as HTMLInputElement).value).toBe('F:\\picked'),
    );
  });

  // Or it would open at the top of the disk every time rather than near the last answer.
  it('opens the picker where the setting already points', async () => {
    const onPickDirectory = vi.fn(async () => null);
    render(
      <SettingsWindow
        settings={{ ...SAVED, workingDirectory: 'F:\\work' }}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onPickDirectory={onPickDirectory}
      />,
    );
    await openSessions();

    await userEvent.click(screen.getByLabelText('Choose a working directory'));

    expect(onPickDirectory).toHaveBeenCalledExactlyOnceWith('F:\\work');
  });

  it('keeps what was there when the picker is dismissed', async () => {
    render(
      <SettingsWindow
        settings={{ ...SAVED, workingDirectory: 'F:\\work' }}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onPickDirectory={async () => null}
      />,
    );
    await openSessions();

    await userEvent.click(screen.getByLabelText('Choose a working directory'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((screen.getByLabelText('Default working directory') as HTMLInputElement).value).toBe('F:\\work');
  });

  it('leaves the picker out when there is none to open', async () => {
    show();
    await openSessions();

    expect(screen.queryByLabelText('Choose a working directory')).toBeNull();
    expect(screen.getByLabelText('Default working directory')).toBeTruthy();
  });

  /**
   * The picker a session uses, rather than one of its own: how hard a model thinks and how
   * much room it has are part of choosing one, and a second control would be a second set
   * of rules to keep in step (#200).
   */
  describe('the model a session starts on', () => {
    const catalogue = [
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        reasoningEfforts: ['low', 'high'] as const,
        contexts: [
          { tier: 'default' as const, maxPromptTokens: 200_000 },
          { tier: 'long_context' as const, maxPromptTokens: 936_000 },
        ],
        needsAgreement: false,
      },
    ];

    const withModels = (over: Partial<Settings> = {}, models: typeof catalogue | [] = catalogue) => {
      const onSave = vi.fn();
      const onClose = vi.fn();
      render(
        <SettingsWindow
          settings={{ ...SAVED, ...over }}
          onSave={onSave}
          onClose={onClose}
          models={models as never}
          onNeedModels={vi.fn()}
        />,
      );
      return { onSave, onClose };
    };

    /** The picker's own trigger, which is the first button in the row. */
    const trigger = () => screen.getByRole('button', { name: /Auto|Claude Opus 5/ });

    const menu = () => screen.queryByRole('listbox');

    describe('putting the menu away', () => {
      it('closes for a press elsewhere in the window', async () => {
        withModels();
        await openSessions();
        await userEvent.click(trigger());
        expect(menu()).not.toBeNull();

        await userEvent.click(screen.getByText('Default working directory'));

        expect(menu()).toBeNull();
      });

      /**
       * The menu is drawn on the body, so it is outside the window it was opened in, and a
       * press that put it away used to close the window along with it.
       */
      it('closes only the menu for a press outside the window', async () => {
        const { onClose } = withModels();
        await openSessions();
        await userEvent.click(trigger());

        await userEvent.click(document.querySelector('.confirm-backdrop') as HTMLElement);

        expect(menu()).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
      });

      it('closes the window for the next press outside it', async () => {
        const { onClose } = withModels();
        await openSessions();
        await userEvent.click(trigger());
        const backdrop = document.querySelector('.confirm-backdrop') as HTMLElement;

        await userEvent.click(backdrop);
        await userEvent.click(backdrop);

        expect(onClose).toHaveBeenCalledOnce();
      });
    });

    it('leaves the choice to the runtime until one is named', async () => {
      withModels();
      await openSessions();

      expect(screen.getByText('Auto')).toBeTruthy();
    });

    it('offers what the app already knows about', async () => {
      withModels();
      await openSessions();

      await userEvent.click(trigger());

      expect(screen.getByRole('option', { name: /Claude Opus 5/ })).toBeTruthy();
    });

    // The whole reason for reusing the session's picker rather than a list of names.
    it('carries how hard it thinks and how much room it has', async () => {
      const { onSave } = withModels();
      await openSessions();

      await userEvent.click(trigger());
      // Effort and room are set on the row, and the name is what commits the row.
      await userEvent.click(screen.getByRole('button', { name: /thinking high/ }));
      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));
      await userEvent.click(commit());

      expect(onSave).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ defaultModel: 'claude-opus-5', defaultEffort: 'high' }),
      );
    });

    it('carries the room size the same way', async () => {
      const { onSave } = withModels();
      await openSessions();

      await userEvent.click(trigger());
      await userEvent.click(screen.getByRole('button', { name: /936k/ }));
      await userEvent.click(screen.getByRole('option', { name: /Claude Opus 5/ }));
      await userEvent.click(commit());

      expect(onSave).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ defaultModel: 'claude-opus-5', defaultContext: 'long_context' }),
      );
    });

    it('shows what was chosen when the window is opened again', async () => {
      withModels({ defaultModel: 'claude-opus-5', defaultEffort: 'high' });
      await openSessions();

      expect(screen.getByText('claude-opus-5')).toBeTruthy();
      expect(screen.getByText('high')).toBeTruthy();
    });

    it('goes back to letting the runtime choose', async () => {
      const { onSave } = withModels({ defaultModel: 'claude-opus-5', defaultEffort: 'high' });
      await openSessions();

      await userEvent.click(screen.getByText(/Reset to auto/));
      await userEvent.click(commit());

      expect(onSave).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ defaultModel: '', defaultEffort: '', defaultContext: '' }),
      );
    });

    it('offers no way back when there is nothing to go back from', async () => {
      withModels();
      await openSessions();

      expect(screen.queryByText(/Reset to auto/)).toBeNull();
    });

    /**
     * The list is fetched on reaching this category rather than on opening the window:
     * reading it costs a server process, and somebody changing the text size has not asked
     * for one (#200).
     */
    it('asks for the catalogue when there is none to show', async () => {
      const onNeedModels = vi.fn();
      render(
        <SettingsWindow settings={SAVED} onSave={vi.fn()} onClose={vi.fn()} models={[]} onNeedModels={onNeedModels} />,
      );
      expect(onNeedModels).not.toHaveBeenCalled();

      await openSessions();

      expect(onNeedModels).toHaveBeenCalledOnce();
    });

    it('asks for nothing when it already has one', async () => {
      const onNeedModels = vi.fn();
      render(
        <SettingsWindow
          settings={SAVED}
          onSave={vi.fn()}
          onClose={vi.fn()}
          models={catalogue as never}
          onNeedModels={onNeedModels}
        />,
      );

      await openSessions();

      expect(onNeedModels).not.toHaveBeenCalled();
    });

    // Or a catalogue that cannot be read would be asked for again on every render.
    it('asks once, however long the answer takes', async () => {
      const onNeedModels = vi.fn();
      render(
        <SettingsWindow settings={SAVED} onSave={vi.fn()} onClose={vi.fn()} models={[]} onNeedModels={onNeedModels} />,
      );

      await openSessions();
      await userEvent.click(tab('Appearance'));
      await openSessions();

      expect(onNeedModels).toHaveBeenCalledOnce();
    });
  });
  it('says what an empty directory means rather than leaving it blank', async () => {    show();
    await openSessions();

    expect((screen.getByLabelText('Default working directory') as HTMLInputElement).placeholder).toBe(
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

  it('names the command it runs, which the label does not', async () => {
    show({ updateOnStart: false });
    await openCli();

    expect(screen.getByText(/Runs copilot update/)).toBeTruthy();
  });
});

/**
 * The size is picked by looking at the result, so it is the one setting here that takes
 * effect while it is still a draft, and is put back if it is not saved (#139).
 */
describe('the app scale', () => {
  const openAppearance = () => userEvent.click(tab('Appearance'));
  const readout = () => screen.getByLabelText('App scale') as HTMLInputElement;
  const applied = () => document.documentElement.style.getPropertyValue('--font-base');

  afterEach(() => document.documentElement.style.removeProperty('--font-base'));

  it('shows the size as a share of the app own', async () => {
    show({ scale: 1.25 });
    await openAppearance();

    expect(readout().value).toBe('125%');
  });

  it('counts up and down in the steps the keyboard uses', async () => {
    show({ scale: 1 });
    await openAppearance();

    await userEvent.click(screen.getByLabelText('Increase app scale'));
    expect(readout().value).toBe('113%');

    await userEvent.click(screen.getByLabelText('Decrease app scale'));
    await userEvent.click(screen.getByLabelText('Decrease app scale'));
    expect(readout().value).toBe('88%');
  });

  it('stops at each end rather than going past it', async () => {
    show({ scale: 2 });
    await openAppearance();
    expect((screen.getByLabelText('Increase app scale') as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    show({ scale: 0.75 });
    await openAppearance();
    expect((screen.getByLabelText('Decrease app scale') as HTMLButtonElement).disabled).toBe(true);
  });

  it('draws at the size being chosen before it is saved', async () => {
    show({ scale: 1 });
    await openAppearance();

    await userEvent.click(screen.getByLabelText('Increase app scale'));

    expect(applied()).toBe('18px');
  });

  it('still has to be saved like anything else', async () => {
    const { onSave } = show({ scale: 1 });
    await openAppearance();

    await userEvent.click(screen.getByLabelText('Increase app scale'));
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.click(commit());
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scale: 1.125 }));
  });

  // Or the app would be left at a size nobody chose, having only been shown it.
  it('goes back to the saved size when the window closes without saving', async () => {
    const { unmount } = render(
      <SettingsWindow settings={{ ...SAVED, scale: 1 }} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    await openAppearance();
    await userEvent.click(screen.getByLabelText('Increase app scale'));
    expect(applied()).toBe('18px');

    unmount();

    expect(applied()).toBe('16px');
  });

  it('offers a way back to the app own size, and only when it is not there', async () => {
    show({ scale: 1 });
    await openAppearance();
    expect(screen.queryByText(/Reset to default sizes/)).toBeNull();

    await userEvent.click(screen.getByLabelText('Increase app scale'));
    await userEvent.click(screen.getByText(/Reset to default sizes/));

    expect(readout().value).toBe('100%');
  });

  /**
   * The note carries the number as well as the readout. It went missing once, leaving a
   * sentence that began with a bare per cent sign, and nothing failed.
   */
  it('shows the size in the box', async () => {
    show({ scale: 1.25 });
    await openAppearance();

    expect((screen.getByLabelText('App scale') as HTMLInputElement).value).toBe('125%');
  });
});

/**
 * A scale of its own on top of the app's. Somebody who finds the letters small is asking
 * for them to grow, not for the panes and the lanes to grow with them - which is what one
 * number gives you (#139).
 */
describe('the text size, apart from the app scale', () => {
  const openAppearance = () => userEvent.click(tab('Appearance'));
  const size = () => screen.getByLabelText('Text size') as HTMLInputElement;
  const appScale = () => screen.getByLabelText('App scale') as HTMLInputElement;
  const base = () => document.documentElement.style.getPropertyValue('--font-base');
  const text = () => document.documentElement.style.getPropertyValue('--text-scale');

  afterEach(() => {
    document.documentElement.style.removeProperty('--font-base');
    document.documentElement.style.removeProperty('--text-scale');
  });

  it('is its own control', async () => {
    show({ scale: 1, textScale: 1.25 });
    await openAppearance();

    expect(size().value).toBe('125%');
    expect(appScale().value).toBe('100%');
  });

  it('moves the letters and leaves everything else alone', async () => {
    show({ scale: 1, textScale: 1 });
    await openAppearance();

    await userEvent.click(screen.getByLabelText('Increase text size'));

    // The app is still drawn at its own size; only the conversation is asked to grow.
    expect(base()).toBe('16px');
    expect(text()).toBe('1.125');
  });

  it('sits on top of the app scale rather than replacing it', async () => {
    show({ scale: 1.5, textScale: 1.25 });
    await openAppearance();

    // The multiplier is the same whatever the app scale, and is applied where it lands.
    expect(base()).toBe('24px');
    expect(text()).toBe('1.25');
  });

  it('is saved as its own setting', async () => {
    const { onSave } = show({ scale: 1, textScale: 1 });
    await openAppearance();

    await userEvent.click(screen.getByLabelText('Increase text size'));
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scale: 1, textScale: 1.125 }));
  });

  it('is put back with the other one when the window closes without saving', async () => {
    const { unmount } = render(
      <SettingsWindow settings={{ ...SAVED, scale: 1, textScale: 1 }} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    await openAppearance();
    await userEvent.click(screen.getByLabelText('Increase text size'));
    expect(text()).toBe('1.125');

    unmount();

    expect(text()).toBe('1');
  });

  it('is taken back to the app own sizes along with the app scale', async () => {
    show({ scale: 1.25, textScale: 1.25 });
    await openAppearance();

    await userEvent.click(screen.getByText(/Reset to default sizes/));

    expect(appScale().value).toBe('100%');
    expect(size().value).toBe('100%');
  });

  it('shows the size in the box', async () => {
    show({ textScale: 1.25 });
    await openAppearance();

    expect((screen.getByLabelText('Text size') as HTMLInputElement).value).toBe('125%');
  });

  // The note describes what is being chosen, not what is saved, or it would explain a size
  // that is not the one on screen.
  it('follows what is being chosen rather than what is saved', async () => {
    show({ textScale: 1 });
    await openAppearance();

    await userEvent.click(screen.getByLabelText('Increase text size'));

    expect((screen.getByLabelText('Text size') as HTMLInputElement).value).toBe('113%');
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
    // siblings in that order. Scoped to this box's own row: the category holds more than
    // one tick box, and the first in the document is not necessarily this one.
    expect(asks().nextElementSibling).toBe(asks().parentElement?.querySelector('.tick'));
    expect(asks().nextElementSibling).toBeTruthy();
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
    show({ confirmDelete: false, binRetentionDays: 0 });
    await userEvent.click(screen.getByText(/Deleting is permanent/));

    expect(asks().checked).toBe(false);
  });

  it('keeps the note out of what can be clicked', async () => {
    show({ confirmDelete: false, binRetentionDays: 0 });
    expect(screen.getByText(/Deleting is permanent/).closest('label')).toBeNull();
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

  it('says which session is released, which the number does not', () => {
    show({ maxLoaded: 3, idleMinutes: 1 });

    expect(screen.getByText(/least recently used is released first/)).toBeTruthy();
    expect(screen.getByText('Minutes. Default 10.')).toBeTruthy();
  });

  // The note describes the draft, or it would explain a setting that is not on screen.
  it('follows what has been typed rather than what is saved', async () => {
    show({ maxLoaded: 0 });

    await userEvent.clear(kept());
    await userEvent.type(kept(), '2');

    expect(screen.getByText(/least recently used is released first/)).toBeTruthy();
    expect(screen.queryByText(/No limit/)).toBeNull();
  });
});

describe('the recycle bin', () => {
  const catalogue: BinnedSession[] = [
    {
      sessionId: 'a',
      title: 'Wiki browser',
      binnedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      updatedAt: '2026-01-02T03:04:05.000Z',
      bytes: 2_400_000,
    },
    {
      sessionId: 'b',
      title: null,
      binnedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      updatedAt: null,
      bytes: 1024,
    },
  ];

  const withBin = (binned: BinnedSession[] | null = catalogue, over: Partial<Settings> = {}) => {
    const onSave = vi.fn();
    const onNeedBin = vi.fn();
    const onRestore = vi.fn();
    const onPurge = vi.fn();
    render(
      <SettingsWindow
        settings={{ ...SAVED, ...over }}
        onSave={onSave}
        onClose={vi.fn()}
        binned={binned}
        onNeedBin={onNeedBin}
        onRestore={onRestore}
        onPurge={onPurge}
      />,
    );
    return { onSave, onNeedBin, onRestore, onPurge };
  };

  // Where the bin lives now, and where the window opens, so this is where it already is.
  const openBin = () => userEvent.click(tab('Session management'));

  /** A section of session management now, rather than a category of its own. */
  it('is a section of session management rather than a category', () => {
    show();

    const names = screen.getAllByRole('button').map((button) => button.textContent);
    expect(names).not.toContain('Recycle bin');
    expect([...document.querySelectorAll('.settings-subhead')].map((node) => node.textContent)).toContain(
      'Recycle bin',
    );
  });

  // Reading it costs a directory listing, which it pays for by being where the window opens.
  it('reads the bin when the category holding it is shown', async () => {
    const { onNeedBin } = withBin();

    expect(onNeedBin).toHaveBeenCalled();
  });

  it('lists what is waiting, with what it was and what it costs', async () => {
    withBin();
    await openBin();

    expect(screen.getByText('Wiki browser')).toBeTruthy();
    expect(screen.getByText(/2.4 MB/)).toBeTruthy();
  });

  it('names a session that never had a title', async () => {
    withBin();
    await openBin();

    expect(screen.getByText('Untitled session')).toBeTruthy();
  });

  it('says the bin is empty rather than showing nothing at all', async () => {
    withBin([]);
    await openBin();

    expect(screen.getByText('Nothing has been deleted.')).toBeTruthy();
  });

  /** Otherwise an empty bin and one still being read look the same. */
  it('says it is reading before it knows', async () => {
    withBin(null);
    await openBin();

    expect(screen.getByText('Reading the bin.')).toBeTruthy();
    expect(screen.queryByText('Nothing has been deleted.')).toBeNull();
  });

  it('puts one back', async () => {
    const { onRestore } = withBin();
    await openBin();

    await userEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0]!);

    expect(onRestore).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('deletes one for good', async () => {
    const { onPurge } = withBin();
    await openBin();

    await userEvent.click(screen.getAllByRole('button', { name: 'Delete now' })[1]!);

    expect(onPurge).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('changes how long one is kept', async () => {
    const { onSave } = withBin();
    await openBin();

    const days = screen.getByLabelText('Keep a deleted session for') as HTMLInputElement;
    await userEvent.clear(days);
    await userEvent.type(days, '30');
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binRetentionDays: 30 }));
  });

  it('says what no retention means', async () => {
    withBin(catalogue, { binRetentionDays: 0 });
    await openBin();

    expect(screen.getByText(/removed immediately/)).toBeTruthy();
  });

  /**
   * Saving applies the new rule to what is already in the bin, and the rows below are all
   * that is left of those sessions - so what it is about to cost is said before it is saved
   * rather than discovered afterwards.
   */
  describe('shortening how long one is kept', () => {
    const shorten = async (days: string) => {
      const field = screen.getByLabelText('Keep a deleted session for') as HTMLInputElement;
      await userEvent.clear(field);
      if (days !== '') await userEvent.type(field, days);
    };

    it('says nothing while the new rule reaches nothing', async () => {
      withBin(catalogue, { binRetentionDays: 30 });
      await openBin();

      expect(screen.queryByText(/Saving will delete/)).toBeNull();
    });

    // One is two hours old and one is twenty-six, so a day reaches the older of the two.
    it('counts what the new rule would take', async () => {
      withBin(catalogue, { binRetentionDays: 30 });
      await openBin();

      await shorten('1');

      expect(screen.getByText(/Saving will delete 1 session below/)).toBeTruthy();
    });

    it('says the bin will be emptied when nothing is to be kept', async () => {
      withBin(catalogue, { binRetentionDays: 30 });
      await openBin();

      await shorten('0');

      expect(screen.getByText('Saving will empty the recycle bin.')).toBeTruthy();
    });

    it('says nothing when the bin is empty', async () => {
      withBin([], { binRetentionDays: 30 });
      await openBin();

      await shorten('0');

      expect(screen.queryByText(/Saving will delete/)).toBeNull();
    });

    /** Or the rows stay on screen after the save that deleted them. */
    it('reads the bin again once the change is saved', async () => {
      const onNeedBin = vi.fn();
      const settings = { ...SAVED, binRetentionDays: 30 };
      const { rerender } = render(
        <SettingsWindow
          settings={settings}
          onSave={vi.fn()}
          onClose={vi.fn()}
          binned={catalogue}
          onNeedBin={onNeedBin}
        />,
      );
      await openBin();
      onNeedBin.mockClear();

      // What the app does after a save: hands back the settings it now holds.
      rerender(
        <SettingsWindow
          settings={{ ...settings, binRetentionDays: 1 }}
          onSave={vi.fn()}
          onClose={vi.fn()}
          binned={catalogue}
          onNeedBin={onNeedBin}
        />,
      );

      expect(onNeedBin).toHaveBeenCalledOnce();
    });

    it('does not read it again for a change that is only typed', async () => {
      const { onNeedBin } = withBin(catalogue, { binRetentionDays: 30 });
      await openBin();
      onNeedBin.mockClear();

      await shorten('1');

      expect(onNeedBin).not.toHaveBeenCalled();
    });
  });

  // The question before deleting says what deleting does, and that changed.
  it('tells the delete question there is a bin', async () => {
    show({ binRetentionDays: 7 });

    expect(screen.getByText(/go to the recycle bin/)).toBeTruthy();
  });

  it('tells it there is not, when there is not', async () => {
    show({ binRetentionDays: 0 });

    expect(screen.getByText(/Deleting is permanent/)).toBeTruthy();
  });
});

/**
 * How long the agent waits for an answer before it answers for you. One number for all
 * four kinds of question, because they are one thing from here (#201).
 */
/**
 * Whether a session runs tools without asking.
 *
 * Under session management rather than with the defaults a new session starts with: the
 * permission mode does not survive a session being released, so this is applied to every
 * session the app opens and to those already open, not only to ones it creates (#199).
 */
describe('running tools without asking', () => {
  const box = () => screen.getByLabelText('Run tools without asking') as HTMLInputElement;

  it('is off to begin with', () => {
    show();

    expect(box().checked).toBe(false);
  });

  it('saves it with everything else', async () => {
    const { onSave } = show();

    await userEvent.click(box());
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allowAll: true }));
  });

  // What is worth knowing is its reach, since it is not limited to sessions made from here.
  it('says how far it reaches', () => {
    show({ allowAll: true });

    expect(screen.getByText(/every session this app opens, including ones already open/)).toBeTruthy();
  });

  it('is not among the defaults a new session starts with', async () => {
    show();
    await userEvent.click(tab('New sessions'));

    expect(screen.queryByLabelText('Run tools without asking')).toBeNull();
  });
});

describe('waiting for an answer', () => {
  const waits = () => screen.getByLabelText('Answer a question for me after') as HTMLInputElement;

  it('starts at the five minutes the runtime uses', () => {
    show();

    expect(waits().value).toBe('5');
  });

  it('says what happens when it runs out', () => {
    show({ permissionMinutes: 2 });

    expect(screen.getByText(/then the turn carries on without it/)).toBeTruthy();
  });

  it('says the default, which is the one number the box cannot show', () => {
    show({ permissionMinutes: 1 });

    expect(screen.getByText(/Default 5\./)).toBeTruthy();
  });

  // Zero is a real answer rather than a broken one, so it says what it means.
  it('says that no wait means it never gives up', () => {
    show({ permissionMinutes: 0 });

    expect(screen.getByText('Never.')).toBeTruthy();
  });

  it('carries the change out', async () => {
    const { onSave } = show({ permissionMinutes: 5 });

    await userEvent.clear(waits());
    await userEvent.type(waits(), '15');
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ permissionMinutes: 15 }));
  });
});

/**
 * The CLI's own settings, drawn from what the CLI says about them rather than written out
 * here, so a setting an update adds appears without this app being rebuilt (#202).
 */
describe("the CLI's own settings", () => {
  const schema: CliSetting[] = [
    { path: 'autoUpdate', kind: 'boolean', description: 'Automatically download updated CLI versions.' },
    { path: 'logLevel', kind: 'enum', description: 'Log verbosity.', options: ['all', 'none'] },
    { path: 'model', kind: 'string', description: 'AI model to use.' },
    { path: 'sandbox.timeout', kind: 'number', description: 'How long a sandbox waits.' },
  ];

  const withCli = (cli: CliSettingsState | null = { settings: schema, values: {} }) => {
    const onNeedCli = vi.fn();
    const onWriteCli = vi.fn();
    render(
      <SettingsWindow
        settings={SAVED}
        onSave={vi.fn()}
        onClose={vi.fn()}
        cli={cli}
        onNeedCli={onNeedCli}
        onWriteCli={onWriteCli}
      />,
    );
    return { onNeedCli, onWriteCli };
  };

  const openCli = () => userEvent.click(tab('Copilot CLI'));
  const press = (path: string, choice: string) =>
    userEvent.click(screen.getByRole('button', { name: `${path} ${choice}` }));

  /**
   * As the window opens rather than on reaching the category: the category is long enough to
   * scroll, and arriving a moment after it is looked at drew it short and then grew it.
   */
  it('reads them as the window opens', () => {
    const { onNeedCli } = withCli(null);

    expect(onNeedCli).toHaveBeenCalledOnce();
  });

  it('asks once rather than on every look', async () => {
    const { onNeedCli } = withCli({ settings: schema, values: {} });

    await openCli();
    await userEvent.click(tab('Appearance'));
    await openCli();

    expect(onNeedCli).not.toHaveBeenCalled();
  });

  it('names each one as the CLI names it, with what the CLI says about it', async () => {
    withCli();
    await openCli();

    expect(screen.getByText('autoUpdate')).toBeTruthy();
    expect(screen.getByText('Automatically download updated CLI versions.')).toBeTruthy();
  });

  it('says it is reading before it knows', async () => {
    withCli(null);
    await openCli();

    expect(screen.getByText('Reading the CLI settings.')).toBeTruthy();
  });

  /** A CLI laid out differently gives nothing, and saying so beats an empty category. */
  it('says so when the CLI could not be read', async () => {
    withCli({ settings: [], values: {} });
    await openCli();

    expect(screen.getByText(/could not be read/)).toBeTruthy();
  });

  /**
   * Three buttons are a group, and the setting's name is the group's name rather than the
   * name of the first button in it.
   *
   * Pointed at one of them, a label does two things a reader did not ask for: clicking the
   * name presses that button, and the browser lights it up whenever the name is hovered -
   * which turned the whole row left of the buttons into a way to switch a setting on.
   */
  describe('the name beside a three-way setting', () => {
    it('does not press one of the three when it is clicked', async () => {
      const { onWriteCli } = withCli();
      await openCli();

      await userEvent.click(screen.getByText('autoUpdate'));

      expect(onWriteCli).not.toHaveBeenCalled();
    });

    it('names the group rather than one button in it', async () => {
      withCli();
      await openCli();

      expect(screen.getByRole('group', { name: 'autoUpdate' })).toBeTruthy();
      // What makes a browser light a control up when its label is hovered.
      expect(screen.getByText('autoUpdate').getAttribute('for')).toBeNull();
    });

    /** Still a label where there is one control, which is where a label belongs. */
    it('still reaches the one control a setting with one has', async () => {
      withCli();
      await openCli();

      expect(screen.getByLabelText('logLevel')).toBeTruthy();
    });
  });

  describe('a setting nobody has chosen', () => {
    it('shows a tick box as neither on nor off', async () => {
      withCli();
      await openCli();

      expect(screen.getByRole('button', { name: 'autoUpdate default' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: 'autoUpdate on' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('leaves a picker on what the CLI would do', async () => {
      withCli();
      await openCli();

      expect((screen.getByLabelText('logLevel') as HTMLSelectElement).value).toBe('');
    });

    it('leaves a field empty rather than filling in a value nobody set', async () => {
      withCli();
      await openCli();

      expect((screen.getByLabelText('model') as HTMLInputElement).value).toBe('');
    });
  });

  /** They are data already, so they carry their own words and their own options. */
  /**
   * The schema is flat and dotted - `sandbox.enabled`, `sandbox.auth.git`, and thirteen more
   * on a real CLI - which drew as a wall of rows of nearly the same name. Gathered under what
   * they are nested in, the category reads as a list of subjects.
   */
  describe('the settings nested under one name', () => {
    const nested: CliSetting[] = [
      { path: 'autoUpdate', kind: 'boolean', description: 'Automatically download updated CLI versions.' },
      { path: 'sandbox.enabled', kind: 'boolean', description: 'Run tools in a sandbox.' },
      { path: 'sandbox.auth.git', kind: 'boolean', description: 'Let the sandbox reach git credentials.' },
      { path: 'ide.autoConnect', kind: 'boolean', description: 'Connect to a running editor.' },
      { path: 'ide.openDiffOnEdit', kind: 'boolean', description: 'Open a diff when a file is edited.' },
      { path: 'customAgents.defaultLocalOnly', kind: 'boolean', description: 'Keep custom agents local.' },
    ];

    const withNested = (values: Record<string, unknown> = {}) => withCli({ settings: nested, values });
    const group = (prefix: string) => screen.getByRole('button', { name: new RegExp(`^${prefix},`) });

    it('draws a heading rather than every setting under it', async () => {
      withNested();
      await openCli();

      expect(group('sandbox')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'sandbox.enabled on' })).toBeNull();
    });

    it('says how many are waiting inside it', async () => {
      withNested();
      await openCli();

      expect(group('sandbox').textContent).toContain('2');
    });

    it('shows them once it is opened', async () => {
      withNested();
      await openCli();

      await userEvent.click(group('sandbox'));

      expect(screen.getByRole('button', { name: 'sandbox.enabled on' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'sandbox.auth.git on' })).toBeTruthy();
    });

    it('puts them away again', async () => {
      withNested();
      await openCli();

      await userEvent.click(group('sandbox'));
      await userEvent.click(group('sandbox'));

      expect(screen.queryByRole('button', { name: 'sandbox.enabled on' })).toBeNull();
    });

    /** The heading already says it, and repeating it spends the width that tells rows apart. */
    it('drops the heading name from what is inside', async () => {
      withNested();
      await openCli();

      await userEvent.click(group('sandbox'));

      expect(screen.getByText('enabled')).toBeTruthy();
      expect(screen.getByText('auth.git')).toBeTruthy();
    });

    it('writes the whole path the CLI knows it by', async () => {
      const { onWriteCli } = withNested();
      await openCli();

      await userEvent.click(group('sandbox'));
      await press('sandbox.auth.git', 'on');

      expect(onWriteCli).toHaveBeenCalledExactlyOnceWith({ 'sandbox.auth.git': true });
    });

    it('shows the value the CLI already has for one inside', async () => {
      withNested({ 'sandbox.enabled': true });
      await openCli();

      await userEvent.click(group('sandbox'));

      expect(screen.getByRole('button', { name: 'sandbox.enabled on' }).getAttribute('aria-pressed')).toBe('true');
    });

    /** A group holding one row is a row you have to open to see one row. */
    it('leaves a lone nested setting as a row of its own', async () => {
      withNested();
      await openCli();

      expect(screen.getByText('customAgents.defaultLocalOnly')).toBeTruthy();
    });

    it('opens each group on its own', async () => {
      withNested();
      await openCli();

      await userEvent.click(group('ide'));

      expect(screen.getByRole('button', { name: 'ide.autoConnect on' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'sandbox.enabled on' })).toBeNull();
    });

    describe('searching inside them', () => {
      const search = async (text: string) => userEvent.type(screen.getByLabelText('Search settings'), text);

      /** The reader has said what they want, and a closed heading asks them twice. */
      it('opens a group it has left standing', async () => {
        withNested();
        await openCli();

        await search('auth');

        expect(screen.getByRole('button', { name: 'sandbox.auth.git on' })).toBeTruthy();
      });

      it('leaves out the ones inside that do not match', async () => {
        withNested();
        await openCli();

        await search('auth');

        expect(screen.queryByRole('button', { name: 'sandbox.enabled on' })).toBeNull();
      });

      it('counts what is left rather than what there was', async () => {
        withNested();
        await openCli();

        await search('auth');

        expect(group('sandbox').textContent).toContain('1');
      });

      // A heading over nothing says a subject is there when none of it is.
      it('takes the heading away when nothing under it matches', async () => {
        withNested();
        await openCli();

        await search('autoConnect');

        expect(screen.queryByRole('button', { name: /^sandbox,/ })).toBeNull();
        expect(screen.getByRole('button', { name: /^ide,/ })).toBeTruthy();
      });

      /** Typing the name of the group is how a reader asks for all of it. */
      it('finds everything under a name by that name', async () => {
        withNested();
        await openCli();

        await search('sandbox');

        expect(screen.getByRole('button', { name: 'sandbox.enabled on' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'sandbox.auth.git on' })).toBeTruthy();
      });
    });
  });

  /**
   * The category holds this app's own answers, and plenty of what a new session answers to
   * is the CLI's instead. Said where somebody would otherwise conclude this was all of it.
   */
  describe('what else decides how a session starts', () => {
    const goToSessions = () => userEvent.click(tab('New sessions'));

    it('says the CLI has its own settings for the same sessions', async () => {
      show();
      await goToSessions();

      expect(screen.getByText(/Defaults for sessions made with the New button/)).toBeTruthy();
    });

    it('takes the reader there', async () => {
      show();
      await goToSessions();

      await userEvent.click(screen.getByRole('button', { name: 'Go to Copilot CLI settings' }));

      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Copilot CLI');
    });

    /** Leaving a category is what asks, and this is one more way of leaving one. */
    it('asks about unsaved changes on the way, like every other way out', async () => {
      show();
      await goToSessions();
      await userEvent.type(screen.getByLabelText('Default working directory'), 'F:\\work');

      await userEvent.click(screen.getByRole('button', { name: 'Go to Copilot CLI settings' }));

      expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeTruthy();
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('New sessions');
    });
  });

  describe('searching them', () => {
    const search = async (text: string) => {
      await userEvent.clear(screen.getByLabelText('Search settings'));
      await userEvent.type(screen.getByLabelText('Search settings'), text);
    };

    it('shows only the ones that match', async () => {
      withCli();
      await openCli();

      await search('autoUpdate');

      expect(screen.getByText('autoUpdate')).toBeTruthy();
      expect(screen.queryByText('logLevel')).toBeNull();
    });

    // The CLI's own wording is often where the useful word is, rather than in its name.
    it('finds one by what the CLI says about it', async () => {
      withCli();
      await openCli();

      await search('verbosity');

      expect(screen.getByText('logLevel')).toBeTruthy();
      expect(screen.queryByText('autoUpdate')).toBeNull();
    });

    it('finds one by what it can be set to', async () => {
      withCli();
      await openCli();

      await search('none');

      expect(screen.getByText('logLevel')).toBeTruthy();
    });

    it('lists the category for one of them, not only for what is written here', async () => {
      withCli();

      await search('verbosity');

      const listed = [...document.querySelectorAll('.settings-tab')].map((node) => node.textContent);
      expect(listed).toEqual(['Copilot CLI']);
    });
  });

  describe('changing one', () => {
    it('writes a tick box', async () => {
      const { onWriteCli } = withCli();
      await openCli();

      await press('autoUpdate', 'on');

      expect(onWriteCli).toHaveBeenCalledExactlyOnceWith({ autoUpdate: true });
    });

    it('writes it off as off rather than as unset', async () => {
      const { onWriteCli } = withCli({ settings: schema, values: { autoUpdate: true } });
      await openCli();

      await press('autoUpdate', 'off');

      expect(onWriteCli).toHaveBeenCalledExactlyOnceWith({ autoUpdate: false });
    });

    /** There is no value meaning "whatever you would have done", so going back is removal. */
    it('takes it out again to go back to what the CLI does', async () => {
      const { onWriteCli } = withCli({ settings: schema, values: { autoUpdate: true } });
      await openCli();

      await press('autoUpdate', 'default');

      expect(onWriteCli).toHaveBeenCalledExactlyOnceWith({ autoUpdate: null });
    });

    it('writes a picker', async () => {
      const { onWriteCli } = withCli();
      await openCli();

      await userEvent.selectOptions(screen.getByLabelText('logLevel'), 'all');

      expect(onWriteCli).toHaveBeenCalledExactlyOnceWith({ logLevel: 'all' });
    });

    it('takes a picker back to what the CLI does', async () => {
      const { onWriteCli } = withCli({ settings: schema, values: { logLevel: 'all' } });
      await openCli();

      await userEvent.selectOptions(screen.getByLabelText('logLevel'), '');

      expect(onWriteCli).toHaveBeenCalledExactlyOnceWith({ logLevel: null });
    });

    it('writes a number as a number rather than as its digits', async () => {
      const { onWriteCli } = withCli();
      await openCli();

      await userEvent.type(screen.getByLabelText('sandbox.timeout'), '5');

      expect(onWriteCli).toHaveBeenCalledExactlyOnceWith({ 'sandbox.timeout': 5 });
    });

    it('empties a field back to what the CLI does', async () => {
      const { onWriteCli } = withCli({ settings: schema, values: { model: 'gpt-5.5' } });
      await openCli();

      await userEvent.clear(screen.getByLabelText('model'));

      expect(onWriteCli).toHaveBeenCalledExactlyOnceWith({ model: null });
    });

    /**
     * They belong to another program's file, so a draft of them held here until Save is a
     * second copy that can disagree with the real one.
     */
    it('writes without waiting for Save', async () => {
      const { onWriteCli } = withCli();
      await openCli();

      await press('autoUpdate', 'on');

      expect(onWriteCli).toHaveBeenCalled();
      expect(commit().disabled).toBe(true);
    });
  });
});

/**
 * Finding a setting without knowing which category it is in. The sidebar and the settings
 * inside a category are filtered by the same rule, since they have to agree (#204).
 */
describe('searching the settings', () => {
  const search = () => screen.getByLabelText('Search settings') as HTMLInputElement;
  const type = async (text: string) => userEvent.type(search(), text);
  const categories = () =>
    [...document.querySelectorAll('.settings-tab')].map((node) => node.textContent);

  it('offers a search field', () => {
    show();

    expect(search()).toBeTruthy();
  });

  it('lists every category before anything is typed', () => {
    show();

    expect(categories()).toEqual([
      'Appearance',
      'Copilot CLI',
      'Keyboard',
      'New sessions',
      'Session management',
      'Transcript',
    ]);
  });

  /**
   * In alphabetical order, so a category is looked up rather than remembered. Checked as a
   * rule rather than against a list, so one added later has to go in the right place.
   */
  it('lists them in alphabetical order', () => {
    show();

    expect(categories()).toEqual([...categories()].sort((a, b) => (a ?? '').localeCompare(b ?? '')));
  });

  /** Named rather than taken from the top of a list whose order says nothing about it. */
  it('opens on session management rather than on whatever sorts first', () => {
    show();

    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Session management');
  });

  it('lists only the categories holding a match', async () => {
    show();

    await type('scale');

    expect(categories()).toEqual(['Appearance']);
  });

  /** Not shown empty and not disabled: a category with nothing in it is not listed at all. */
  it('leaves a category out rather than showing it empty', async () => {
    show();

    await type('retention');

    expect(categories()).toEqual(['Session management']);
  });

  it('shows only the settings that match, within the category being looked at', async () => {
    show();

    await type('idle');

    expect(screen.getByLabelText('Release an idle session after')).toBeTruthy();
    expect(screen.queryByLabelText('Sessions kept in memory')).toBeNull();
  });

  it('finds one by what it is about rather than by its name', async () => {
    show();

    // Nothing in the label says "cap", and it is what somebody would look for.
    await type('cap');

    expect(screen.getByLabelText('Sessions kept in memory')).toBeTruthy();
  });

  it('says so when nothing matches anywhere', async () => {
    show();

    await type('nothinglikethis');

    expect(categories()).toEqual([]);
    expect(screen.getByText('Nothing matches.')).toBeTruthy();
  });

  it('puts everything back when the search is cleared', async () => {
    show();
    await type('scale');

    await userEvent.clear(search());

    expect(categories()).toHaveLength(6);
    expect(screen.getByLabelText('Sessions kept in memory')).toBeTruthy();
  });

  /** Searching changes no setting, so it is not something to be stopped and asked about. */
  it('does not ask about unsaved changes', async () => {
    show({ maxLoaded: 3 });
    await userEvent.clear(kept());
    await userEvent.type(kept(), '9');

    await type('scale');

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

/**
 * The sidebar has to know whether a category holds a match before anybody opens it, so what
 * each one holds is written down as well as drawn. A label changed in one place and not the
 * other would leave a setting unfindable, or a category listed as holding something it does
 * not - neither of which fails on its own (#204).
 */
describe('what the search is told a category holds', () => {
  const labelled = () =>
    [...document.querySelectorAll('.settings-row')]
      .map((row) => row.querySelector('.settings-label')?.textContent?.trim())
      .filter((label): label is string => Boolean(label));

  it.each([
    ['Session management', 'management'],
    ['New sessions', 'sessions'],
    ['Appearance', 'appearance'],
  ])('knows about every setting drawn in %s', async (name) => {
    show();
    await userEvent.click(tab(name));
    const drawn = labelled();
    expect(drawn.length, `${name} should draw something`).toBeGreaterThan(0);

    for (const label of drawn) {
      await userEvent.clear(screen.getByLabelText('Search settings'));
      await userEvent.type(screen.getByLabelText('Search settings'), label);

      // The sidebar is the half that can only answer from what it was told, so it is the
      // half that catches a setting drawn but never written down.
      const listed = [...document.querySelectorAll('.settings-tab')].map((node) => node.textContent);
      expect(listed, `searching "${label}" should list ${name}`).toContain(name);
    }
  });
});

/**
 * When a turn ends with a line saying what it changed (#40).
 *
 * Three answers rather than a tick: the useful one is in the middle, where a turn that made
 * a single edit is left to the row that made it.
 */
describe('summarising what a turn changed', () => {
  const choice = () => screen.getByLabelText('Summarise what a turn changed') as HTMLSelectElement;

  it('shows which answer is in force', async () => {
    show({ turnSummary: 'multiple' });
    await userEvent.click(tab('Transcript'));

    expect(choice().value).toBe('multiple');
  });

  it('offers turning it off, and saves that', async () => {
    const { onSave } = show({ turnSummary: 'always' });
    await userEvent.click(tab('Transcript'));

    await userEvent.selectOptions(choice(), 'off');
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ turnSummary: 'off' }));
  });

  // Held as a draft like everything else in this window, rather than applied as it is picked.
  it('does not save an answer that was not confirmed', async () => {
    const { onSave } = show({ turnSummary: 'always' });
    await userEvent.click(tab('Transcript'));

    await userEvent.selectOptions(choice(), 'multiple');

    expect(onSave).not.toHaveBeenCalled();
  });

  /**
   * Not under Appearance, which is where it started: that category is how things are drawn,
   * and this changes what the transcript reports rather than how it looks.
   */
  it('is not among the appearance settings', async () => {
    show();
    await userEvent.click(tab('Appearance'));

    expect(screen.queryByLabelText('Summarise what a turn changed')).toBeNull();
  });
});

/**
 * Whether the sidebar draws a session's tags on its row (#123).
 *
 * Under Appearance, unlike the turn summary above it: this changes how the list is drawn
 * rather than what anything reports. The tags themselves are untouched.
 */
describe('showing tags in the sidebar', () => {
  const openAppearance = () => userEvent.click(tab('Appearance'));

  it('is offered where the rest of the drawing is', async () => {
    show();
    await openAppearance();

    expect(screen.getByLabelText('Show tags in the sidebar')).toBeTruthy();
  });

  it('starts from what was saved', async () => {
    show({ sidebarTags: false });
    await openAppearance();

    expect((screen.getByLabelText('Show tags in the sidebar') as HTMLInputElement).checked).toBe(false);
  });

  it('shows them by default', async () => {
    show();
    await openAppearance();

    expect((screen.getByLabelText('Show tags in the sidebar') as HTMLInputElement).checked).toBe(true);
  });

  it('saves being turned off', async () => {
    const { onSave } = show();
    await openAppearance();

    await userEvent.click(screen.getByLabelText('Show tags in the sidebar'));
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sidebarTags: false }));
  });
});

/**
 * How many lines of the last reply a sidebar row gives up (#240).
 *
 * Capped rather than open: five lines of prose under every title turns a list of sessions
 * into a list of paragraphs, and the list is what the sidebar is for.
 */
describe('how much of the last reply the sidebar shows', () => {
  const openAppearance = () => userEvent.click(tab('Appearance'));
  const lines = () => screen.getByLabelText('Lines of the last reply in the sidebar') as HTMLInputElement;
  const more = () => screen.getByLabelText('More lines of the last reply in the sidebar') as HTMLButtonElement;
  const fewer = () => screen.getByLabelText('Fewer lines of the last reply in the sidebar') as HTMLButtonElement;

  it('is offered where the rest of the drawing is', async () => {
    show();
    await openAppearance();

    expect(lines()).toBeTruthy();
  });

  it('starts from what was saved', async () => {
    show({ sidebarPreviewLines: 4 });
    await openAppearance();

    expect(lines().value).toBe('4');
  });

  it('saves what was chosen', async () => {
    const { onSave } = show();
    await openAppearance();

    await userEvent.click(more());
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sidebarPreviewLines: 3 }));
  });

  it('takes none at all, which switches it off', async () => {
    const { onSave } = show({ sidebarPreviewLines: 1 });
    await openAppearance();

    await userEvent.click(fewer());
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sidebarPreviewLines: 0 }));
  });

  it('offers no more once it is at the most a row can hold', async () => {
    show({ sidebarPreviewLines: 5 });
    await openAppearance();

    expect(more().disabled).toBe(true);
  });

  it('offers no fewer once there are none', async () => {
    show({ sidebarPreviewLines: 0 });
    await openAppearance();

    expect(fewer().disabled).toBe(true);
  });

  it('refuses a typed number past the cap', async () => {
    const { onSave } = show();
    await openAppearance();

    fireEvent.change(lines(), { target: { value: '30' } });
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sidebarPreviewLines: 5 }));
  });

  it('refuses a typed number below none', async () => {
    const { onSave } = show();
    await openAppearance();

    fireEvent.change(lines(), { target: { value: '-4' } });
    await userEvent.click(commit());

    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sidebarPreviewLines: 0 }));
  });

  it('is found by what it is for rather than only by its name', async () => {
    show();

    // Nothing in the label says "preview", and it is what somebody would look for.
    await userEvent.type(screen.getByLabelText('Search settings'), 'preview');
    await openAppearance();

    expect(lines()).toBeTruthy();
  });
});