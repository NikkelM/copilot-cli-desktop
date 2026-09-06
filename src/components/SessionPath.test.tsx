// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
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
};

describe('SessionPath', () => {
  it('names the branch beside the directory', () => {
    render(<SessionPath cwd={'C:\\work\\repo'} state={clean} />);
    expect(screen.getByText(/main/)).toBeTruthy();
  });

  // A session started without one is a conversation, not a piece of work on a directory.
  it('says nothing when a session has no directory', () => {
    const { container } = render(<SessionPath cwd={null} state={clean} />);
    expect(container.textContent).toBe('');
  });

  it('shows the path alone outside a repository', () => {
    const { container } = render(<SessionPath cwd={'C:\\work\\loose'} state={null} />);
    expect(container.textContent).toBe('C:\\work\\loose');
  });

  describe('the markers', () => {
    it('leaves a clean tree unmarked', () => {
      const { container } = render(<SessionPath cwd={'C:\\work\\repo'} state={clean} />);
      expect(container.textContent).toContain('main');
      expect(container.textContent).not.toMatch(/[*+%]/);
    });

    it.each([
      [{ modified: true }, 'main*'],
      [{ staged: true }, 'main+'],
      [{ untracked: true }, 'main%'],
      [{ modified: true, staged: true, untracked: true }, 'main*+%'],
    ])('writes %o as the prompt would', (state, expected) => {
      const { container } = render(<SessionPath cwd={'C:\\work\\repo'} state={{ ...clean, ...state }} />);
      expect(container.textContent).toContain(expected);
    });

    // The symbols are borrowed from a shell prompt and mean nothing to anyone who has not
    // seen them there.
    it('spells out what the markers mean', () => {
      render(<SessionPath cwd={'C:\\work\\repo'} state={{ ...clean, modified: true, untracked: true }} />);
      expect(screen.getByTitle('on branch main, unstaged changes, untracked files')).toBeTruthy();
    });

    it('says a detached head is detached rather than calling the commit a branch', () => {
      render(<SessionPath cwd={'C:\\work\\repo'} state={{ ...clean, branch: 'a1b2c3d4', detached: true }} />);
      expect(screen.getByTitle('detached at a1b2c3d4')).toBeTruthy();
    });
  });

  it('writes the home directory as a shell would', async () => {
    const { container } = render(<SessionPath cwd={'C:\\Users\\test\\Projects\\thing'} state={null} />);

    // The home directory is asked of the system, so it arrives a tick after the first paint.
    await vi.waitFor(() => expect(container.textContent).toBe('~\\Projects\\thing'));
  });
});
