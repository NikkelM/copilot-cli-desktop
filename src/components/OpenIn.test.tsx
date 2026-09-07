// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenIn } from './OpenIn';

const openPath = vi.fn();
const openUrl = vi.fn();

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: (...args: unknown[]) => openPath(...args),
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

beforeEach(() => {
  openPath.mockReset().mockResolvedValue(undefined);
  openUrl.mockReset().mockResolvedValue(undefined);
});

const show = (props: Partial<Parameters<typeof OpenIn>[0]> = {}) =>
  render(<OpenIn cwd={null} remote={null} branch={null} onError={() => {}} {...props} />);

describe('OpenIn', () => {
  it('opens the working directory', async () => {
    show({ cwd: 'C:\\work\\repo' });

    await userEvent.click(screen.getByRole('button', { name: /Folder/ }));

    expect(openPath).toHaveBeenCalledWith('C:\\work\\repo');
  });

  // Through the URI rather than the command, which would depend on it being on PATH.
  // `windowId=_blank` is the part that stops it replacing whatever was open in the window
  // that happened to be focused, which is what it does without it.
  it('opens the directory in a new editor window by URI', async () => {
    show({ cwd: 'C:\\work\\repo' });

    await userEvent.click(screen.getByRole('button', { name: /VS Code/ }));

    expect(openUrl).toHaveBeenCalledWith('vscode-insiders://file/C:/work/repo?windowId=_blank');
  });

  /**
   * Mid-session, the branch being worked on is what is wanted, not the default one.
   *
   * Each segment is escaped rather than the whole name, because GitHub writes a branch with
   * slashes in it as a path - `tree/feature/x`. Escaping the slash gave `tree/feature%2Fx`,
   * which is a 404.
   */
  it('links a repository to the branch the session is on', async () => {
    show({ remote: 'NikkelM/thing', branch: 'feature/x' });

    await userEvent.click(screen.getByRole('button', { name: /GitHub/ }));

    expect(openUrl).toHaveBeenCalledWith('https://github.com/NikkelM/thing/tree/feature/x');
  });

  it('escapes what has to be escaped in a branch name', async () => {
    show({ remote: 'NikkelM/thing', branch: 'fix/a b#c' });

    await userEvent.click(screen.getByRole('button', { name: /GitHub/ }));

    expect(openUrl).toHaveBeenCalledWith('https://github.com/NikkelM/thing/tree/fix/a%20b%23c');
  });

  it('links to the repository itself when there is no branch', async () => {
    show({ remote: 'NikkelM/thing' });

    await userEvent.click(screen.getByRole('button', { name: /GitHub/ }));

    expect(openUrl).toHaveBeenCalledWith('https://github.com/NikkelM/thing');
  });

  /**
   * A session without a repository, or without a directory at all, is normal here rather
   * than an error - non-repository folders are a case this app deliberately supports.
   */
  describe('what it hides', () => {
    it('offers nothing for a session with no directory', () => {
      show({ remote: 'NikkelM/thing' });

      expect(screen.queryByRole('button', { name: /Folder/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /VS Code/ })).toBeNull();
    });

    it('offers no repository for a folder that is not one', () => {
      show({ cwd: 'C:\\work\\loose' });

      expect(screen.queryByRole('button', { name: /GitHub/ })).toBeNull();
    });

    it('shows nothing at all with neither', () => {
      const { container } = show();

      expect(container.textContent).toBe('');
    });
  });

  it('reports a refusal rather than swallowing it', async () => {
    openPath.mockRejectedValue(new Error('not permitted'));
    const onError = vi.fn();
    show({ cwd: 'C:\\work\\repo', onError });

    await userEvent.click(screen.getByRole('button', { name: /Folder/ }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('not permitted')));
  });
});
