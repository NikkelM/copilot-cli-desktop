// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Shortcuts } from './Shortcuts';
import { BINDINGS } from '../lib/useShortcuts';

describe('Shortcuts', () => {
  // Built from the bindings themselves, so it cannot describe a key that does nothing.
  it('lists every shortcut there is', () => {
    render(<Shortcuts onClose={() => {}} />);

    for (const binding of BINDINGS) {
      expect(screen.getByText(binding.keys)).toBeTruthy();
      expect(screen.getByText(binding.what)).toBeTruthy();
    }
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
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
});
