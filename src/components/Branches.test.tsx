// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Branches, carryNote } from './Branches';

const list = [
  { name: 'main', current: true },
  { name: 'feature', current: false },
];

const Picker = (props: Partial<Parameters<typeof Branches>[0]> = {}) => (
  <Branches
    branch="main"
    branches={list}
    switching={false}
    onOpen={() => {}}
    onSwitch={() => {}}
    {...props}
  />
);

describe('carryNote', () => {
  it('says nothing about a clean tree, which carries nothing', () => {
    expect(carryNote(0)).toBeNull();
  });

  it('counts one file as one file', () => {
    expect(carryNote(1)).toBe('1 changed file carries over');
  });

  it('counts the rest as files', () => {
    expect(carryNote(4)).toBe('4 changed files carry over');
  });
});

/**
 * The picker is reached from the source control panel and from the header indicator (#102),
 * so what is shared is tested here once rather than twice over from either end.
 */
describe('Branches', () => {
  it('wears the face its caller gives it', async () => {
    render(<Picker label={<span>⎇ main*</span>} className="branch link" />);
    const trigger = screen.getByRole('button', { name: 'Switch branch, on main' });

    expect(trigger.className).toBe('branch link');
    expect(trigger.textContent).toContain('⎇ main*');
  });

  describe('putting it away', () => {
    it('closes when something outside it is clicked', async () => {
      const user = userEvent.setup();
      render(
        <div>
          <Picker />
          <button type="button">elsewhere</button>
        </div>,
      );

      await user.click(screen.getByRole('button', { name: 'Switch branch, on main' }));
      expect(screen.getByLabelText('New branch name')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'elsewhere' }));
      expect(screen.queryByLabelText('New branch name')).toBeNull();
    });

    it('stays open when something inside it is clicked', async () => {
      const user = userEvent.setup();
      render(<Picker />);

      await user.click(screen.getByRole('button', { name: 'Switch branch, on main' }));
      await user.click(screen.getByLabelText('New branch name'));
      expect(screen.queryByLabelText('New branch name')).toBeTruthy();
    });

    it('closes on escape', async () => {
      const user = userEvent.setup();
      render(<Picker />);

      await user.click(screen.getByRole('button', { name: 'Switch branch, on main' }));
      await user.keyboard('{Escape}');
      expect(screen.queryByLabelText('New branch name')).toBeNull();
    });

    // Reopening on a name half typed would offer to create something nobody asked for.
    it('forgets a half-typed name when it closes', async () => {
      const user = userEvent.setup();
      render(<Picker />);

      await user.click(screen.getByRole('button', { name: 'Switch branch, on main' }));
      await user.type(screen.getByLabelText('New branch name'), 'spi');
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Switch branch, on main' }));

      expect((screen.getByLabelText('New branch name') as HTMLInputElement).value).toBe('');
    });
  });

  /** A checkout already running is the one thing that makes a second one a race. */
  it('will not open while a checkout is in flight', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Picker switching onOpen={onOpen} />);

    await user.click(screen.getByRole('button'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('New branch name')).toBeNull();
  });

  // Open, then something starts: the menu goes rather than hanging over a moving tree.
  it('drops an open menu when a checkout starts', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Picker />);

    await user.click(screen.getByRole('button', { name: 'Switch branch, on main' }));
    expect(screen.getByLabelText('New branch name')).toBeTruthy();

    rerender(<Picker switching />);
    expect(screen.queryByLabelText('New branch name')).toBeNull();
  });
});
