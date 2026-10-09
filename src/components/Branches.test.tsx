// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
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

/**
 * Which empty a menu is showing (#224).
 *
 * The list is read only when the picker opens, so there is a moment with nothing in it. An
 * empty list means two things - not read yet, and read and found nothing - and drawing both
 * the same way says the repository has no branches, which on any repository is wrong.
 */
describe('a picker with nothing in it yet', () => {
  const open = async (props: Partial<Parameters<typeof Branches>[0]> = {}) => {
    const user = userEvent.setup();
    render(<Picker {...props} />);
    await user.click(screen.getByRole('button', { name: /Switch branch/ }));
  };

  it('says it is reading while the list is on its way', async () => {
    await open({ branches: [], reading: true });

    expect(screen.getByText('Reading the branches.')).toBeTruthy();
  });

  // Read and genuinely empty, which git makes nearly impossible but the menu should survive.
  it('says nothing about reading once the read is done', async () => {
    await open({ branches: [], reading: false });

    expect(screen.queryByText('Reading the branches.')).toBeNull();
  });

  // The answer arrived, so the branches are what to look at rather than a note about them.
  it('shows the branches rather than the note once they are there', async () => {
    await open({ reading: true });

    expect(screen.queryByText('Reading the branches.')).toBeNull();
    expect(screen.getByRole('button', { name: 'main' })).toBeTruthy();
  });

  /**
   * Making one is the way out of an empty picker, so it stays reachable: a reader whose
   * branches cannot be read can still start the branch they came to start.
   */
  it('still offers to make a branch while it reads', async () => {
    await open({ branches: [], reading: true });

    expect(screen.getByPlaceholderText(/new branch/i)).toBeTruthy();
  });
});

/** A menu is where a reader reaches for an arrow hardest of all (#249). */
describe('walking the branches with the arrows', () => {
  const items = () => [...document.querySelectorAll('.repo-branch-item')] as HTMLElement[];
  const open = async () => {
    const user = userEvent.setup();
    render(<Picker />);
    await user.click(screen.getByRole('button', { name: /Switch branch/ }));
    return user;
  };

  /** The keyboard is still on the control that opened it, which is beside the menu. */
  it('walks in from the control that opened it', async () => {
    await open();

    fireEvent.keyDown(screen.getByRole('button', { name: /Switch branch/ }), { key: 'ArrowDown' });

    expect(document.activeElement).toBe(items()[0]);
  });

  it.each([
    ['ArrowDown', 0, 1],
    ['ArrowUp', 1, 0],
    ['Home', 1, 0],
  ])('moves on %s', async (key, from, to) => {
    await open();
    items()[from]!.focus();

    fireEvent.keyDown(items()[from]!, { key });

    expect(document.activeElement).toBe(items()[to]);
  });

  /**
   * Starting a branch is the other half of what this menu is for, so the box belongs to it
   * rather than sitting after it - which is where End lands and where down from the last
   * branch carries on to.
   */
  it('carries on into the box that starts a branch', async () => {
    await open();
    items()[items().length - 1]!.focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(screen.getByLabelText('New branch name'));
  });

  it('comes back out of the box to the branches', async () => {
    await open();
    screen.getByLabelText('New branch name').focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(items()[items().length - 1]);
  });

  it('leaves the arrow alone while the menu is shut', () => {
    render(<Picker />);
    const button = screen.getByRole('button', { name: /Switch branch/ });
    button.focus();

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
