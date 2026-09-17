// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRepoStatus } from './useRepoStatus';
import type { RepoStatus } from '../../shared/protocol';

const { gitStatus, gitDiff, gitStage } = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  gitStage: vi.fn(),
}));

vi.mock('./sidecar', () => ({
  gitStatus: (cwd: string) => gitStatus(cwd),
  gitDiff: (cwd: string, path: string, staged: boolean) => gitDiff(cwd, path, staged),
  gitStage: (cwd: string, path: string, staged: boolean) => gitStage(cwd, path, staged),
}));

const clean: RepoStatus = { branch: 'main', detached: false, ahead: 0, behind: 0, files: [] };

beforeEach(() => {
  gitStatus.mockReset().mockResolvedValue(clean);
  gitDiff.mockReset().mockResolvedValue({ patch: 'a patch', stale: false });
  gitStage.mockReset().mockResolvedValue(clean);
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


/**
 * Staging through the hook. Git is the authority on what happened, so the tree it reports
 * afterwards is taken as the new state rather than the panel assuming what staging did.
 */
describe('staging a path', () => {
  const afterStaging: RepoStatus = { ...clean, files: [{ path: 'a.ts', staged: 'modified' }] };

  it('asks the sidecar and takes the tree it answers with', async () => {
    gitStage.mockResolvedValue(afterStaging);
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    await act(async () => void (await result.current.stage('a.ts', true)));

    expect(gitStage).toHaveBeenCalledWith('C:\\repo', 'a.ts', true);
    expect(result.current.status).toEqual(afterStaging);
  });

  it('marks the path as working while it is in flight', async () => {
    let settle!: (status: RepoStatus) => void;
    gitStage.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    act(() => void result.current.stage('a.ts', true));
    await waitFor(() => expect(result.current.busy).toEqual(['a.ts']));

    await act(async () => {
      settle(afterStaging);
      await Promise.resolve();
    });
    expect(result.current.busy).toEqual([]);
  });

  /** The file has moved between the lists, so a diff held for it describes where it was. */
  it('gives up the diffs it held', async () => {
    gitStage.mockResolvedValue(afterStaging);
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));
    act(() => result.current.diff('a.ts', false));
    await waitFor(() => expect(Object.keys(result.current.diffs)).toHaveLength(1));

    await act(async () => void (await result.current.stage('a.ts', true)));

    expect(result.current.diffs).toEqual({});
  });

  it('says what could not be done', async () => {
    gitStage.mockRejectedValue(new Error('the index is locked'));
    const { result } = renderHook(() => useRepoStatus('C:\\repo', true));
    await waitFor(() => expect(result.current.status).toEqual(clean));

    await act(async () => void (await result.current.stage('a.ts', true)));

    expect(result.current.failed).toContain('the index is locked');
    expect(result.current.busy).toEqual([]);
  });

  it('does nothing for a session with no directory', async () => {
    const { result } = renderHook(() => useRepoStatus(null, true));

    await act(async () => void (await result.current.stage('a.ts', true)));

    expect(gitStage).not.toHaveBeenCalled();
  });
});

