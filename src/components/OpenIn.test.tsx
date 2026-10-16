// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenIn } from './OpenIn';

const openUrl = vi.fn();
const onOpenDirectory = vi.fn();

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

beforeEach(() => {
  openUrl.mockReset().mockResolvedValue(undefined);
  onOpenDirectory.mockReset();
});

const show = (props: Partial<Parameters<typeof OpenIn>[0]> = {}) =>
  render(<OpenIn cwd={null} remote={null} branch={null} onError={() => {}}
    applications={[{ id: 'folder', label: 'File Explorer' }, { id: 'vscode', label: 'VS Code' }]}
    target="folder" loading={false} onOpenDirectory={onOpenDirectory} {...props} />);

describe('OpenIn', () => {
  it('opens the working directory', async () => {
    show({ cwd: 'C:\\work\\repo' });

    await userEvent.click(screen.getByRole('button', { name: 'Open in File Explorer' }));

    expect(onOpenDirectory).toHaveBeenCalledWith('C:\\work\\repo');
  });

  it('names the configured application without offering a dropdown', async () => {
    show({ cwd: 'C:\\work\\repo', target: 'vscode' });
    expect(screen.queryByRole('combobox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }));
    expect(onOpenDirectory).toHaveBeenCalledExactlyOnceWith('C:\\work\\repo');
  });

  it('shows only discovered applications and never falls back from a missing preference', () => {
    show({ cwd: 'C:\\repo', target: 'removed-editor', applications: [{ id: 'folder', label: 'File Explorer' }] });
    expect((screen.getByRole('button', { name: 'Open in configured application' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('option', { name: 'VS Code' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
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

      expect(screen.queryByRole('button', { name: /^Open in/ })).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
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
    openUrl.mockRejectedValue(new Error('not permitted'));
    const onError = vi.fn();
    show({ remote: 'NikkelM/thing', onError });

    await userEvent.click(screen.getByRole('button', { name: 'GitHub' }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('not permitted')));
  });
});
