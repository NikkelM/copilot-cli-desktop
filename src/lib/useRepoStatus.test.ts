// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRepoStatus } from './useRepoStatus';
import type { RepoStatus } from '../../shared/protocol';

const { gitStatus, gitDiff } = vi.hoisted(() => ({ gitStatus: vi.fn(), gitDiff: vi.fn() }));

vi.mock('./sidecar', () => ({
  gitStatus: (cwd: string) => gitStatus(cwd),
  gitDiff: (cwd: string, path: string, staged: boolean) => gitDiff(cwd, path, staged),
}));

const clean: RepoStatus = { branch: 'main', detached: false, ahead: 0, behind: 0, files: [] };

beforeEach(() => {
  gitStatus.mockReset().mockResolvedValue(clean);
  gitDiff.mockReset().mockResolvedValue({ patch: 'a patch', stale: false });
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

/**
 * A diff answers the state the status was read in. Once the tree is read again the file may
 * have moved on, so anything held would describe something no longer true.
 */
describe('diffs the reader has opened', () => {
  it('asks git for the side the row belongs to', async () => {
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    act(() => result.current.diff('a.ts', false));

    await waitFor(() => expect(gitDiff).toHaveBeenCalledWith('C:\\repo', 'a.ts', false));
  });

  it('holds each side of a file apart', async () => {
    gitDiff.mockImplementation((_cwd: string, _path: string, staged: boolean) =>
      Promise.resolve({ patch: staged ? 'staged patch' : 'tree patch', stale: false }),
    );
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    act(() => result.current.diff('a.ts', true));
    act(() => result.current.diff('a.ts', false));

    await waitFor(() => expect(Object.keys(result.current.diffs)).toHaveLength(2));
    expect(result.current.diffs['staged:a.ts']?.patch).toBe('staged patch');
    expect(result.current.diffs['unstaged:a.ts']?.patch).toBe('tree patch');
  });

  it('asks only once for a row opened twice', async () => {
    gitDiff.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    act(() => result.current.diff('a.ts', false));
    act(() => result.current.diff('a.ts', false));

    expect(gitDiff).toHaveBeenCalledTimes(1);
  });

  it('gives up what it held when the tree is read again', async () => {
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));
    act(() => result.current.diff('a.ts', false));
    await waitFor(() => expect(Object.keys(result.current.diffs)).toHaveLength(1));

    act(() => result.current.refresh());

    expect(result.current.diffs).toEqual({});
  });

  // A diff read against the old tree must not land under a row describing the new one.
  it('drops a diff that arrives after the tree was read again', async () => {
    let settle!: (diff: unknown) => void;
    gitDiff.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    act(() => result.current.diff('a.ts', false));
    act(() => result.current.refresh());
    await act(async () => {
      settle({ patch: 'from the old tree', stale: false });
      await Promise.resolve();
    });

    expect(result.current.diffs).toEqual({});
  });

  /** A row that said it was reading for as long as it stayed open would be worse than a gap. */
  it('reports a diff it could not read rather than saying nothing', async () => {
    gitDiff.mockRejectedValue(new Error('git exploded'));
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    act(() => result.current.diff('a.ts', false));

    await waitFor(() => expect(result.current.diffs['unstaged:a.ts']).toEqual({ patch: null, stale: false }));
  });
});

