// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRepoStatus } from './useRepoStatus';
import type { RepoStatus } from '../../shared/protocol';

const { gitStatus } = vi.hoisted(() => ({ gitStatus: vi.fn() }));

vi.mock('./sidecar', () => ({ gitStatus: (cwd: string) => gitStatus(cwd) }));

const clean: RepoStatus = { branch: 'main', detached: false, ahead: 0, behind: 0, files: [] };

beforeEach(() => {
  gitStatus.mockReset().mockResolvedValue(clean);
});

describe('reading the repository only when it is being looked at', () => {
  /** A status walk is cheap but not free, and most sessions never open the panel. */
  it('asks nothing while the panel is closed', () => {
    renderHook(() => useRepoStatus('C:\\repo', false));

    expect(gitStatus).not.toHaveBeenCalled();
  });

  it('reads it once the panel is opened', async () => {
    const { result } = renderHook(({ open }) => useRepoStatus('C:\\repo', open), {
      initialProps: { open: true },
    });

    await waitFor(() => expect(result.current.status).toEqual(clean));
    expect(gitStatus).toHaveBeenCalledWith('C:\\repo');
  });

  it('asks nothing for a session with no directory', () => {
    renderHook(() => useRepoStatus(null, true));

    expect(gitStatus).not.toHaveBeenCalled();
  });

  it('reads it again on request', async () => {
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    act(() => result.current.refresh());

    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2));
  });
});

describe('moving between sessions', () => {
  /** Another repository's files under this session's name is worse than an empty panel. */
  it('forgets the last repository before reading the next', async () => {
    const { result, rerender } = renderHook(({ cwd }) => useRepoStatus(cwd, true), {
      initialProps: { cwd: 'C:\\one' },
    });
    await waitFor(() => expect(result.current.status).toEqual(clean));

    gitStatus.mockImplementation(() => new Promise(() => {}));
    rerender({ cwd: 'C:\\two' });

    expect(result.current.status).toBeNull();
  });

  it('ignores a reply for a session that has been left', async () => {
    let settleFirst!: (status: RepoStatus) => void;
    gitStatus.mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)));
    const { result, rerender } = renderHook(({ cwd }) => useRepoStatus(cwd, true), {
      initialProps: { cwd: 'C:\\one' },
    });

    gitStatus.mockResolvedValue({ ...clean, branch: 'second' });
    rerender({ cwd: 'C:\\two' });
    await waitFor(() => expect(result.current.status?.branch).toBe('second'));

    await act(async () => {
      settleFirst({ ...clean, branch: 'first' });
      await Promise.resolve();
    });

    expect(result.current.status?.branch).toBe('second');
  });
});

/**
 * A directory outside a repository and one that could not be read get the same answer,
 * because the panel does the same thing for both: says there is nothing to show.
 */
describe('a directory git has nothing to say about', () => {
  it('holds nothing when git says nothing', async () => {
    gitStatus.mockResolvedValue(null);
    const { result } = renderHook(() => useRepoStatus('C:\\plain', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeNull();
  });

  it('holds nothing when the read fails outright', async () => {
    gitStatus.mockRejectedValue(new Error('git is not installed'));
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeNull();
  });
});
