// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SessionPath } from './SessionPath';
import type { TreeState } from '../../shared/protocol';

vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('C:\\Users\\test') }));
const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl, openPath: vi.fn() }));

const clean: TreeState = {
  branch: 'main',
  detached: false,
  modified: false,
  untracked: false,
  staged: false,
  remote: null,
};

/** The error sink is the same for every case here, so it is filled in rather than repeated. */
const Path = (props: Omit<Parameters<typeof SessionPath>[0], 'onError'>) => (
  <SessionPath {...props} onError={() => {}} />
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
   * The branch is the obvious thing to click to go and look at the work, so it does what
   * the GitHub button does - but only when there is somewhere for it to go.
   */
  describe('as a link', () => {
    it('opens the branch on GitHub when the checkout has a remote', async () => {
      const user = userEvent.setup();
      render(<Path cwd={'C:\\work\\repo'} state={{ ...clean, remote: 'NikkelM/thing' }} />);

      await user.click(screen.getByRole('button'));
      expect(openUrl).toHaveBeenCalledWith('https://github.com/NikkelM/thing/tree/main');
    });

    it('stays plain text when the checkout has no GitHub remote', () => {
      render(<Path cwd={'C:\\work\\repo'} state={clean} />);
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('says where clicking goes', () => {
      render(<Path cwd={'C:\\work\\repo'} state={{ ...clean, modified: true, remote: 'NikkelM/thing' }} />);
      expect(screen.getByTitle('on branch main, unstaged changes - open on GitHub')).toBeTruthy();
    });
  });
});
