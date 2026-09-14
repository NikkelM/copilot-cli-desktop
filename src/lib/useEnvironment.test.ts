// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEnvironment } from './useEnvironment';
import type { SessionEnvironment } from '../../shared/protocol';

const describeEnvironment = vi.fn();

vi.mock('./sidecar', () => ({
  describeEnvironment: (cwd?: string) => describeEnvironment(cwd),
}));

const environment: SessionEnvironment = {
  instructions: [
    {
      id: 'home-copilot',
      label: 'Home copilot-instructions.md',
      sourcePath: 'C:\\Users\\x\\.copilot\\copilot-instructions.md',
      content: '# Rules',
      type: 'home',
      location: 'user',
    },
  ],
  plugins: [{ name: 'project-planning', marketplace: 'awesome-copilot', version: '1.0.0', enabled: true }],
  extensions: [],
  skills: [],
  skillErrors: [],
  extensionMode: 'load_and_augment',
};

/** A promise that can be settled from the test, for checking what happens mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  describeEnvironment.mockReset().mockResolvedValue(environment);
});

describe('useEnvironment', () => {
  it('asks for nothing until it is asked', () => {
    renderHook(() => useEnvironment('C:\\repo'));

    expect(describeEnvironment).not.toHaveBeenCalled();
  });

  it('reads the environment for the directory it was given', async () => {
    const { result } = renderHook(() => useEnvironment('C:\\repo'));

    await act(async () => void (await result.current.load()));

    expect(describeEnvironment).toHaveBeenCalledWith('C:\\repo');
    expect(result.current.environment).toEqual(environment);
    expect(result.current.failed).toBeNull();
  });

  it('asks about no directory when the session has none', async () => {
    const { result } = renderHook(() => useEnvironment(null));

    await act(async () => void (await result.current.load()));

    expect(describeEnvironment).toHaveBeenCalledWith(undefined);
  });

  it('says so while it is reading', async () => {
    const pending = deferred<SessionEnvironment>();
    describeEnvironment.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useEnvironment('C:\\repo'));
    act(() => void result.current.load());

    expect(result.current.loading).toBe(true);

    await act(async () => {
      pending.resolve(environment);
      await pending.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('reports a failure rather than showing nothing', async () => {
    describeEnvironment.mockRejectedValue(new Error('no runtime'));

    const { result } = renderHook(() => useEnvironment('C:\\repo'));
    await act(async () => void (await result.current.load()));

    expect(result.current.failed).toContain('no runtime');
    expect(result.current.environment).toBeNull();
  });

  it('forgets what it read once the directory changes', async () => {
    const { result, rerender } = renderHook(({ cwd }) => useEnvironment(cwd), {
      initialProps: { cwd: 'C:\\repo' },
    });
    await act(async () => void (await result.current.load()));
    expect(result.current.environment).not.toBeNull();

    rerender({ cwd: 'C:\\elsewhere' });

    expect(result.current.environment).toBeNull();
  });

  it('drops an answer about the directory that was left', async () => {
    const pending = deferred<SessionEnvironment>();
    describeEnvironment.mockReturnValue(pending.promise);

    const { result, rerender } = renderHook(({ cwd }) => useEnvironment(cwd), {
      initialProps: { cwd: 'C:\\repo' },
    });
    act(() => void result.current.load());

    rerender({ cwd: 'C:\\elsewhere' });
    await act(async () => {
      pending.resolve(environment);
      await pending.promise;
    });

    expect(result.current.environment).toBeNull();
  });

  it('reads again rather than trusting what it read before', async () => {
    const { result } = renderHook(() => useEnvironment('C:\\repo'));

    await act(async () => void (await result.current.load()));
    await act(async () => void (await result.current.load()));

    expect(describeEnvironment).toHaveBeenCalledTimes(2);
  });

  it('clears an earlier failure when asked again', async () => {
    describeEnvironment.mockRejectedValueOnce(new Error('no runtime'));

    const { result } = renderHook(() => useEnvironment('C:\\repo'));
    await act(async () => void (await result.current.load()));
    expect(result.current.failed).not.toBeNull();

    await act(async () => void (await result.current.load()));

    expect(result.current.failed).toBeNull();
    expect(result.current.environment).toEqual(environment);
  });
});
