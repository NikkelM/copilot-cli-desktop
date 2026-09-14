// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDirectories } from './useDirectories';

const sessionDirectories = vi.fn();
const addSessionDirectory = vi.fn();
const removeSessionDirectory = vi.fn();

vi.mock('./sidecar', () => ({
  sessionDirectories: (sessionId: string) => sessionDirectories(sessionId),
  addSessionDirectory: (sessionId: string, path: string) => addSessionDirectory(sessionId, path),
  removeSessionDirectory: (sessionId: string, path: string) => removeSessionDirectory(sessionId, path),
}));

/** A promise that can be settled from the test, for checking what happens mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  sessionDirectories.mockReset().mockResolvedValue({ directories: [] });
  addSessionDirectory.mockReset().mockResolvedValue({ directories: [] });
  removeSessionDirectory.mockReset().mockResolvedValue({ directories: [], untilRestart: false });
});

describe('useDirectories', () => {
  it('reads what the session may reach when it is selected', async () => {
    sessionDirectories.mockResolvedValue({ directories: ['C:\\wiki'] });

    const { result } = renderHook(() => useDirectories('s1'));

    await waitFor(() => expect(result.current.directories).toEqual(['C:\\wiki']));
    expect(sessionDirectories).toHaveBeenCalledWith('s1');
  });

  it('asks nothing when there is no session', () => {
    renderHook(() => useDirectories(null));

    expect(sessionDirectories).not.toHaveBeenCalled();
  });

  it('grants a directory', async () => {
    addSessionDirectory.mockResolvedValue({ directories: ['C:\\wiki'] });
    const { result } = renderHook(() => useDirectories('s1'));
    await waitFor(() => expect(sessionDirectories).toHaveBeenCalled());

    await act(async () => {
      await result.current.add('C:\\wiki');
    });

    expect(addSessionDirectory).toHaveBeenCalledWith('s1', 'C:\\wiki');
    expect(result.current.directories).toEqual(['C:\\wiki']);
  });

  it('takes the whole list back, not the change', async () => {
    sessionDirectories.mockResolvedValue({ directories: ['a', 'b'] });
    removeSessionDirectory.mockResolvedValue({ directories: ['b'], untilRestart: false });
    const { result } = renderHook(() => useDirectories('s1'));
    await waitFor(() => expect(result.current.directories).toEqual(['a', 'b']));

    await act(async () => {
      await result.current.remove('a');
    });

    expect(result.current.directories).toEqual(['b']);
  });

  it('changes nothing when there is no session to change it for', async () => {
    const { result } = renderHook(() => useDirectories(null));

    await act(async () => {
      await result.current.add('C:\\wiki');
      await result.current.remove('C:\\wiki');
    });

    expect(addSessionDirectory).not.toHaveBeenCalled();
    expect(removeSessionDirectory).not.toHaveBeenCalled();
  });

  // The runtime cannot withdraw a directory from a live session, so the reader is told
  // rather than shown a change that has not happened.
  describe('a directory a loaded session still holds', () => {
    it('is remembered as pending', async () => {
      removeSessionDirectory.mockResolvedValue({ directories: [], untilRestart: true });
      const { result } = renderHook(() => useDirectories('s1'));
      await waitFor(() => expect(sessionDirectories).toHaveBeenCalled());

      await act(async () => {
        await result.current.remove('C:\\wiki');
      });

      expect(result.current.pending).toEqual(['C:\\wiki']);
    });

    it('is not remembered when the session was cold', async () => {
      const { result } = renderHook(() => useDirectories('s1'));
      await waitFor(() => expect(sessionDirectories).toHaveBeenCalled());

      await act(async () => {
        await result.current.remove('C:\\wiki');
      });

      expect(result.current.pending).toEqual([]);
    });

    it('is listed once however often it is withdrawn', async () => {
      removeSessionDirectory.mockResolvedValue({ directories: [], untilRestart: true });
      const { result } = renderHook(() => useDirectories('s1'));
      await waitFor(() => expect(sessionDirectories).toHaveBeenCalled());

      await act(async () => {
        await result.current.remove('C:\\wiki');
        await result.current.remove('C:\\wiki');
      });

      expect(result.current.pending).toEqual(['C:\\wiki']);
    });

    // Granting it back settles the warning: the session holds it either way, and now that
    // is what was asked for.
    it('stops being pending once it is granted again', async () => {
      removeSessionDirectory.mockResolvedValue({ directories: [], untilRestart: true });
      addSessionDirectory.mockResolvedValue({ directories: ['C:\\wiki'] });
      const { result } = renderHook(() => useDirectories('s1'));
      await waitFor(() => expect(sessionDirectories).toHaveBeenCalled());
      await act(async () => {
        await result.current.remove('C:\\wiki');
      });

      await act(async () => {
        await result.current.add('C:\\wiki');
      });

      expect(result.current.pending).toEqual([]);
    });
  });

  // One session's grants must never be shown against another's.
  it('forgets the last session when another is selected', async () => {
    sessionDirectories.mockResolvedValue({ directories: ['C:\\wiki'] });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDirectories(id), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.directories).toEqual(['C:\\wiki']));

    sessionDirectories.mockResolvedValue({ directories: [] });
    rerender({ id: 's2' });

    expect(result.current.directories).toEqual([]);
  });

  it('forgets a pending withdrawal when another session is selected', async () => {
    removeSessionDirectory.mockResolvedValue({ directories: [], untilRestart: true });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDirectories(id), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(sessionDirectories).toHaveBeenCalled());
    await act(async () => {
      await result.current.remove('C:\\wiki');
    });

    rerender({ id: 's2' });

    expect(result.current.pending).toEqual([]);
  });

  it('lets a slow answer for an old session fall on the floor', async () => {
    const slow = deferred<{ directories: string[] }>();
    sessionDirectories.mockReturnValueOnce(slow.promise).mockResolvedValue({ directories: ['for-s2'] });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDirectories(id), {
      initialProps: { id: 's1' },
    });

    rerender({ id: 's2' });
    await waitFor(() => expect(result.current.directories).toEqual(['for-s2']));
    await act(async () => {
      slow.resolve({ directories: ['for-s1'] });
    });

    expect(result.current.directories).toEqual(['for-s2']);
  });

  it('says so when the list cannot be read', async () => {
    sessionDirectories.mockRejectedValue(new Error('no store'));

    const { result } = renderHook(() => useDirectories('s1'));

    await waitFor(() => expect(result.current.failed).toContain('no store'));
  });

  // The store refuses a path that is not a directory, and the reader picked it, so they
  // are the one who needs telling.
  it('says so when a directory is refused', async () => {
    addSessionDirectory.mockRejectedValue(new Error('Not a directory: C:\\gone'));
    const { result } = renderHook(() => useDirectories('s1'));
    await waitFor(() => expect(sessionDirectories).toHaveBeenCalled());

    await act(async () => {
      await result.current.add('C:\\gone');
    });

    expect(result.current.failed).toContain('Not a directory');
  });

  it('says so when a withdrawal does not take', async () => {
    removeSessionDirectory.mockRejectedValue(new Error('would not write'));
    const { result } = renderHook(() => useDirectories('s1'));
    await waitFor(() => expect(sessionDirectories).toHaveBeenCalled());

    await act(async () => {
      await result.current.remove('C:\\wiki');
    });

    expect(result.current.failed).toContain('would not write');
  });
});
