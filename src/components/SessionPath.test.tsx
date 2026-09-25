// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SessionPath } from './SessionPath';
import type { TreeState } from '../../shared/protocol';

vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('C:\\Users\\test') }));

const clean: TreeState = {
  branch: 'main',
  detached: false,
  modified: false,
  untracked: false,
  staged: false,
  remote: null,
};

/** The wiring is the same for every case here, so it is filled in rather than repeated. */
const Path = (
  props: Partial<Parameters<typeof SessionPath>[0]> & { cwd: string | null; state: TreeState | null },
) => (
  <SessionPath
    branches={[]}
    switching={false}
    busy={false}
    onBranches={() => {}}
    onSwitch={() => {}}
    {...props}
  />
);

describe('SessionPath', () => {
  it('names the branch beside the directory', () => {
    render(<Path cwd={'C:\\work\\repo'} state={clean} />);
    expect(screen.getByText(/main/)).toBeTruthy();
  });

  // A session started without one is a conversation, not a piece of work on a directory.
  it('says nothing when a session has no directory', () => {
    const { container } = render(<Path cwd={null} state={clean} />);
    expect(container.textContent).toBe('');
  });

  it('shows the path alone outside a repository', () => {
    const { container } = render(<Path cwd={'C:\\work\\loose'} state={null} />);
    expect(container.textContent).toBe('C:\\work\\loose');
  });

  describe('the markers', () => {
    it('leaves a clean tree unmarked', () => {
      const { container } = render(<Path cwd={'C:\\work\\repo'} state={clean} />);
      expect(container.textContent).toContain('main');
      expect(container.textContent).not.toMatch(/[*+%]/);
    });

    it.each([
      [{ modified: true }, 'main*'],
      [{ staged: true }, 'main+'],
      [{ untracked: true }, 'main%'],
      [{ modified: true, staged: true, untracked: true }, 'main*+%'],
    ])('writes %o as the prompt would', (state, expected) => {
      const { container } = render(<Path cwd={'C:\\work\\repo'} state={{ ...clean, ...state }} />);
      expect(container.textContent).toContain(expected);
    });

    // The symbols are borrowed from a shell prompt and mean nothing to anyone who has not
    // seen them there.
    it('spells out what the markers mean', () => {
      render(<Path cwd={'C:\\work\\repo'} state={{ ...clean, modified: true, untracked: true }} />);
      expect(screen.getByTitle('on branch main, unstaged changes, untracked files')).toBeTruthy();
    });

    it('says a detached head is detached rather than calling the commit a branch', () => {
      render(<Path cwd={'C:\\work\\repo'} state={{ ...clean, branch: 'a1b2c3d4', detached: true }} />);
      expect(screen.getByTitle('detached at a1b2c3d4')).toBeTruthy();
    });
  });

  it('writes the home directory as a shell would', async () => {
    const { container } = render(<Path cwd={'C:\\Users\\test\\Projects\\thing'} state={null} />);

    // The home directory is asked of the system, so it arrives a tick after the first paint.
    await vi.waitFor(() => expect(container.textContent).toBe('~\\Projects\\thing'));
  });

  /**
   * Noticing the branch is the moment it wants changing, so the indicator is the control
   * rather than a label to read and then go elsewhere to act on (#102).
   */
  describe('as a branch picker', () => {
    const list = [
      { name: 'main', current: true },
      { name: 'feature', current: false },
    ];

    it('reads the branches only once the picker is opened', async () => {
      const user = userEvent.setup();
      const onBranches = vi.fn();
      render(<Path cwd={'C:\\work\\repo'} state={clean} onBranches={onBranches} />);

      expect(onBranches).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button'));
      expect(onBranches).toHaveBeenCalled();
    });

    it('switches to a branch that is chosen', async () => {
      const user = userEvent.setup();
      const onSwitch = vi.fn();
      render(<Path cwd={'C:\\work\\repo'} state={clean} branches={list} onSwitch={onSwitch} />);

      await user.click(screen.getByRole('button'));
      await user.click(screen.getByRole('button', { name: 'feature' }));
      expect(onSwitch).toHaveBeenCalledWith('feature', false);
    });

    it('makes a branch from a name that is not in the list', async () => {
      const user = userEvent.setup();
      const onSwitch = vi.fn();
      render(<Path cwd={'C:\\work\\repo'} state={clean} branches={list} onSwitch={onSwitch} />);

      await user.click(screen.getByRole('button'));
      await user.type(screen.getByLabelText('New branch name'), 'spike');
      await user.click(screen.getByRole('button', { name: 'Create' }));
      expect(onSwitch).toHaveBeenCalledWith('spike', true);
    });

    // Switching underneath a working agent would produce a diff nobody could explain.
    it('refuses while a turn is running, and says why', async () => {
      const user = userEvent.setup();
      const onBranches = vi.fn();
      render(<Path cwd={'C:\\work\\repo'} state={clean} busy onBranches={onBranches} />);

      const trigger = screen.getByRole('button');
      expect(trigger.hasAttribute('disabled')).toBe(true);
      expect(trigger.getAttribute('title')).toBe('Cannot switch branch while the agent is working');
      await user.click(trigger);
      expect(onBranches).not.toHaveBeenCalled();
    });

    it('says what a switch would carry across, and nothing when the tree is clean', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<Path cwd={'C:\\work\\repo'} state={clean} branches={list} />);
      await user.click(screen.getByRole('button'));
      expect(screen.queryByText('Changed files carry over')).toBeNull();

      rerender(<Path cwd={'C:\\work\\repo'} state={{ ...clean, modified: true }} branches={list} />);
      expect(screen.getByText('Changed files carry over')).toBeTruthy();
    });

    // A commit is not a branch: there is no name to switch away from.
    it('stays plain text on a detached HEAD', () => {
      render(<Path cwd={'C:\\work\\repo'} state={{ ...clean, branch: 'a1b2c3d4', detached: true }} />);
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('says which branch it is on, where a screen reader can hear it', () => {
      render(<Path cwd={'C:\\work\\repo'} state={clean} />);
      expect(screen.getByRole('button', { name: 'Switch branch, on main' })).toBeTruthy();
    });
  });
});
