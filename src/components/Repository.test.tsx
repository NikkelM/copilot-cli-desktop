// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Repository } from './Repository';
import type { RepoStatus } from '../../shared/protocol';

const clean: RepoStatus = { branch: 'main', detached: false, ahead: 0, behind: 0, files: [] };

const shown = (status: RepoStatus | null, over: Partial<Parameters<typeof Repository>[0]> = {}) =>
  render(
    <Repository
      status={status}
      loading={false}
      cwd={'C:\\repo'}
      onRefresh={() => {}}
      onClose={() => {}}
      {...over}
    />,
  );

describe('what the repository is doing', () => {
  it('names the branch', () => {
    shown(clean);

    expect(screen.getByText('main')).toBeTruthy();
  });

  it('names the branch it tracks', () => {
    shown({ ...clean, upstream: 'origin/main' });

    expect(screen.getByText(/origin\/main/)).toBeTruthy();
  });

  it('says how far ahead and behind it is', () => {
    shown({ ...clean, upstream: 'origin/main', ahead: 3, behind: 2 });

    expect(screen.getByText('↑3')).toBeTruthy();
    expect(screen.getByText('↓2')).toBeTruthy();
  });

  /** A pair of zeroes on every clean repository is punctuation, not information. */
  it('says nothing about counts when there is nothing to say', () => {
    shown({ ...clean, upstream: 'origin/main' });

    expect(screen.queryByText('↑0')).toBeNull();
    expect(screen.queryByText('↓0')).toBeNull();
  });

  it('shows the commit when there is no branch to name', () => {
    shown({ ...clean, branch: 'f42b1f39', detached: true });

    expect(screen.getByText('f42b1f39')).toBeTruthy();
  });
});

describe('the files it lists', () => {
  const changed: RepoStatus = {
    ...clean,
    files: [
      { path: 'src/kept.ts', staged: 'modified' },
      { path: 'src/new.ts', unstaged: 'untracked' },
      { path: 'gone.ts', unstaged: 'deleted' },
    ],
  };

  it('separates what is staged from what is not', () => {
    shown(changed);

    expect(screen.getByText('Staged')).toBeTruthy();
    expect(screen.getByText('Changes')).toBeTruthy();
  });

  it('names each file', () => {
    shown(changed);

    expect(screen.getByText('kept.ts')).toBeTruthy();
    expect(screen.getByText('new.ts')).toBeTruthy();
    expect(screen.getByText('gone.ts')).toBeTruthy();
  });

  /** Read by filename, with the directories after it and quieter. */
  it('puts the folder after the name it belongs to', () => {
    const view = shown(changed);

    expect(view.container.querySelector('.repo-folder')?.textContent).toBe('src/');
  });

  /** Part of the file is going into the commit and part of it is not, which is two rows. */
  it('shows a file staged and then changed again under both headings', () => {
    shown({ ...clean, files: [{ path: 'both.ts', staged: 'modified', unstaged: 'modified' }] });

    expect(screen.getAllByText('both.ts')).toHaveLength(2);
  });

  it('leaves out a heading with nothing under it', () => {
    shown({ ...clean, files: [{ path: 'only.ts', unstaged: 'modified' }] });

    expect(screen.queryByText('Staged')).toBeNull();
    expect(screen.getByText('Changes')).toBeTruthy();
  });

  it('says where a rename came from', () => {
    shown({ ...clean, files: [{ path: 'new-name.ts', staged: 'renamed', from: 'old-name.ts' }] });

    expect(screen.getByTitle('new-name.ts (was old-name.ts)')).toBeTruthy();
  });

  it('says so when nothing has changed', () => {
    shown(clean);

    expect(screen.getByText('Nothing has changed.')).toBeTruthy();
  });
});

/** A session in a plain folder is an ordinary session, not an error. */
describe('a session that is not in a repository', () => {
  it('says so rather than showing an empty list', () => {
    shown(null);

    expect(screen.getByText('Not a git repository.')).toBeTruthy();
  });

  it('says so when the session has no directory at all', () => {
    shown(null, { cwd: null });

    expect(screen.getByText('This session has no working directory.')).toBeTruthy();
  });

  // Nothing read yet is not the same as nothing there, and saying the wrong one is worse.
  it('does not call it a plain folder while it is still reading', () => {
    shown(null, { loading: true });

    expect(screen.getByText('Reading the repository…')).toBeTruthy();
    expect(screen.queryByText('Not a git repository.')).toBeNull();
  });
});

describe('asking again', () => {
  it('reads the repository again on request', async () => {
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    shown(clean, { onRefresh });

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(onRefresh).toHaveBeenCalled();
  });

  it('cannot be asked twice at once', () => {
    shown(clean, { loading: true });

    expect(screen.getByRole('button', { name: 'Reading…' })).toHaveProperty('disabled', true);
  });

  it('closes on request', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    shown(clean, { onClose });

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalled();
  });
});
