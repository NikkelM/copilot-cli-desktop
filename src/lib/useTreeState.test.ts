// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTreeState } from './useTreeState';
import type { TreeState } from '../../shared/protocol';

const gitState = vi.fn();
vi.mock('./sidecar', () => ({ gitState: (cwd: string) => gitState(cwd) }));

const on = (branch: string): TreeState => ({
  branch,
  detached: false,
  modified: false,
  untracked: false,
  staged: false,
  remote: null,
});

beforeEach(() => {
  gitState.mockReset();
  gitState.mockResolvedValue(on('main'));
});

describe('useTreeState', () => {
  it('asks about the directory it is given', async () => {
    const { result } = renderHook(() => useTreeState('C:\\work\\repo'));

    await waitFor(() => expect(result.current.state?.branch).toBe('main'));
    expect(gitState).toHaveBeenCalledWith('C:\\work\\repo');
  });

  it('asks nothing for a session with no directory', () => {
    const { result } = renderHook(() => useTreeState(null));

    expect(gitState).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  // Nothing changes the working tree except work being done in it, so a render is not a
  // reason to walk a large repository again.
  it('does not ask again because it rendered', async () => {
    const { result, rerender } = renderHook(() => useTreeState('C:\\work\\repo'));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    rerender();
    rerender();

    expect(gitState).toHaveBeenCalledTimes(1);
  });

  it('asks again when told the tree may have changed', async () => {
    const { result } = renderHook(() => useTreeState('C:\\work\\repo'));
    await waitFor(() => expect(result.current.state?.branch).toBe('main'));

    gitState.mockResolvedValue(on('feature'));
    await act(async () => result.current.refresh());

    await waitFor(() => expect(result.current.state?.branch).toBe('feature'));
  });

  // The previous session's branch beside this one's path would be read as this one's.
  it('forgets the old branch the moment the directory changes', async () => {
    const { result, rerender } = renderHook(({ cwd }) => useTreeState(cwd), {
      initialProps: { cwd: 'C:\\work\\repo' as string | null },
    });
    await waitFor(() => expect(result.current.state).not.toBeNull());

    gitState.mockReturnValue(new Promise(() => {}));
    rerender({ cwd: 'C:\\work\\other' });

    expect(result.current.state).toBeNull();
  });

  // A slow answer for a directory nobody is looking at any more describes somewhere else.
  it('ignores an answer that arrives after the reader moved on', async () => {
    let answer: (state: TreeState) => void = () => {};
    gitState.mockReturnValueOnce(new Promise<TreeState>((resolve) => (answer = resolve)));

    const { result, rerender } = renderHook(({ cwd }) => useTreeState(cwd), {
      initialProps: { cwd: 'C:\\work\\repo' as string | null },
    });

    gitState.mockResolvedValue(on('second'));
    rerender({ cwd: 'C:\\work\\other' });
    await waitFor(() => expect(result.current.state?.branch).toBe('second'));

    await act(async () => answer(on('first')));
    expect(result.current.state?.branch).toBe('second');
  });

  it('shows nothing rather than an error when git cannot answer', async () => {
    gitState.mockRejectedValue(new Error('no git here'));
    const { result } = renderHook(() => useTreeState('C:\\work\\loose'));

    await waitFor(() => expect(gitState).toHaveBeenCalled());
    expect(result.current.state).toBeNull();
  });
});

/**
 * App subscribes to the runtime once, when it starts, and holds whatever callbacks it was
 * given then for the rest of the run. One that changes identity when the reader opens
 * another session is therefore one the subscription will never be handed again: it goes on
 * answering for whichever session was open at the moment the app started, which was none.
 *
 * That is how the live half of the todo list came to have never worked. The rule is cheap to
 * state and cheap to check, so it is checked here rather than left to be remembered.
 */describe('the identity App subscribes with', () => {
  it('survives the reader moving to another directory', () => {
    const view = renderHook(({ cwd }: { cwd: string }) => useTreeState(cwd), { initialProps: { cwd: 'C:\\one' } });
    const { refresh } = view.result.current;

    view.rerender({ cwd: 'C:\\two' });

    expect(view.result.current.refresh).toBe(refresh);
  });
});