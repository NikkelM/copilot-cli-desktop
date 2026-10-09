// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Shortcuts } from './Shortcuts';
import { BINDINGS } from '../lib/useShortcuts';
import { resolveBindings } from '../lib/bindings';
import type { SlashCommand } from '../../shared/protocol';

describe('Shortcuts', () => {
  // Built from the bindings themselves, so it cannot describe a key that does nothing.
  it('lists every shortcut there is', () => {
    render(<Shortcuts onClose={() => {}} />);

    for (const binding of BINDINGS) {
      expect(screen.getByText(binding.keys)).toBeTruthy();
      expect(screen.getByText(binding.what)).toBeTruthy();
    }
  });

  /**
   * A list showing what the keys used to be would be worse than no list at all, so this is
   * built from the keys as they are rather than from the defaults (#246).
   */
  it('shows a key a reader moved', () => {
    render(<Shortcuts onClose={() => {}} bindings={resolveBindings({ sidebar: 'ctrl+shift+b' })} />);

    expect(screen.getByText('ctrl+shift+b')).toBeTruthy();
    expect(screen.queryByText('ctrl+b')).toBeNull();
  });

  /** The row stays, so a reader can see what the key would do if they gave it one back. */
  it('says so for a key a reader turned off', () => {
    render(<Shortcuts onClose={() => {}} bindings={resolveBindings({ sidebar: '' })} />);

    expect(screen.getByText('show or hide the sidebar')).toBeTruthy();
    expect(screen.getAllByText('not set')).toHaveLength(1);
  });

  /** Two cleared keys are two rows, not one: a list cannot have two rows under one key. */
  it('keeps both rows when two keys were turned off', () => {
    render(<Shortcuts onClose={() => {}} bindings={resolveBindings({ sidebar: '', wiki: '' })} />);

    expect(screen.getAllByText('not set')).toHaveLength(2);
  });

  it('closes on Escape', async () => {    const onClose = vi.fn();
    render(<Shortcuts onClose={onClose} />);

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  /**
   * A list of keys should not be something you have to learn a key to escape from, so
   * carrying on with anything at all closes it.
   */
  it.each(['a', ' ', '{Backspace}', '{Enter}', '{ArrowDown}'])('closes on %s', async (key) => {
    const onClose = vi.fn();
    render(<Shortcuts onClose={onClose} />);

    await userEvent.keyboard(key);

    expect(onClose).toHaveBeenCalled();
  });

  // Reaching for a combination is not carrying on. Observed in the CLI, whose help stays up
  // while Ctrl is held.
  it('stays open while a modifier is held on its own', async () => {
    const onClose = vi.fn();
    render(<Shortcuts onClose={onClose} />);

    await userEvent.keyboard('{Control>}');

    expect(onClose).not.toHaveBeenCalled();
  });

  // It is drawn above the composer rather than over the window, so there is no backdrop to
  // click and nothing to trap the keyboard.
  it('is a list rather than a dialogue', () => {
    render(<Shortcuts onClose={() => {}} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  // Read rather than picked from, so it flows into columns as the CLI's quick help does.
  it('flows into columns', () => {
    const { container } = render(<Shortcuts onClose={() => {}} />);

    expect(container.querySelector('.menu-columns')).toBeTruthy();
  });

  // A cursor on a list that cannot be moved through is a control that is not there.
  it('marks no row as current', () => {
    render(<Shortcuts onClose={() => {}} />);

    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
  });

  /**
   * `?` asks for the keys, `/help` for everything. Same list, one longer, exactly as the CLI
   * divides its quick help from its full help.
   */
  describe('given commands', () => {
    const commands: SlashCommand[] = [
      { name: 'model', description: 'choose a model', aliases: [], allowDuringTurn: true },
      { name: 'usage', description: 'show token usage', aliases: [], allowDuringTurn: true },
    ];

    it('lists them under the keys', () => {
      render(<Shortcuts commands={commands} onClose={() => {}} />);

      expect(screen.getByText('/model')).toBeTruthy();
      expect(screen.getByText('choose a model')).toBeTruthy();
      expect(screen.getByText('?')).toBeTruthy();
    });

    it('says it is the full help, not the shortcuts', () => {
      render(<Shortcuts commands={commands} onClose={() => {}} />);

      expect(screen.getByRole('listbox', { name: 'Help' })).toBeTruthy();
    });

    // Nothing is fetched to draw it: the list is whatever is already known, so reading the
    // help never starts a server.
    it('draws without any commands at all', () => {
      render(<Shortcuts commands={[]} onClose={() => {}} />);

      expect(screen.getByText('?')).toBeTruthy();
    });

    // The quick list names /help so it can be found from `?`, which would say it twice here.
    it('says a command the keys already name only once', () => {
      const help: SlashCommand = { name: 'help', description: 'show full help', aliases: [], allowDuringTurn: true };
      render(<Shortcuts commands={[...commands, help]} onClose={() => {}} />);

      expect(screen.getAllByText('/help')).toHaveLength(1);
    });
  });
});
