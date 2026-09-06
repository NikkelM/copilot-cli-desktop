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

  // Otherwise the same press would also reach the shortcut that stops a turn.
  it('keeps that Escape to itself', async () => {
    render(<Shortcuts onClose={() => {}} />);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

    document.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
  });

  it('closes when the sheet around it is clicked', async () => {
    const onClose = vi.fn();
    render(<Shortcuts onClose={onClose} />);

    await userEvent.click(screen.getByRole('dialog'));

    expect(onClose).toHaveBeenCalled();
  });

  // Clicking the list itself is not asking to dismiss it.
  it('stays open when the list is clicked', async () => {
    const onClose = vi.fn();
    render(<Shortcuts onClose={onClose} />);

    await userEvent.click(screen.getByText('Keyboard shortcuts'));

    expect(onClose).not.toHaveBeenCalled();
  });
});
