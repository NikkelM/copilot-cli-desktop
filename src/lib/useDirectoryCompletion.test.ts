// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { splitDirectoryInput, useDirectoryCompletion } from './useDirectoryCompletion';
import type { SlashCommand } from '../../shared/protocol';

const { listDirectories } = vi.hoisted(() => ({ listDirectories: vi.fn() }));

vi.mock('./sidecar', () => ({
  listDirectories: (cwd: string | undefined, path: string) => listDirectories(cwd, path),
}));

const command = (completesDirectories = true): SlashCommand => ({
  name: 'cwd',
  description: 'Change directory',
  aliases: ['cd'],
  hint: 'directory',
  ...(completesDirectories ? { completion: 'directory' as const } : {}),
  allowDuringTurn: true,
});

beforeEach(() => {
  listDirectories.mockReset().mockResolvedValue({
    entries: ['.github', 'Source', 'src', 'tests'],
    separator: '\\',
    caseSensitive: false,
  });
});

describe('splitting a directory argument', () => {
  it('filters the current working directory before a separator is typed', () => {
    expect(splitDirectoryInput('sr')).toEqual({ directory: '', base: '', prefix: 'sr' });
  });

  it.each([
    ['src\\com', { directory: 'src\\', base: 'src\\', prefix: 'com', separator: '\\' }],
    ['src/com', { directory: 'src/', base: 'src/', prefix: 'com', separator: '/' }],
  ])('keeps the path style in %s', (input, expected) => {
    expect(splitDirectoryInput(input)).toEqual(expected);
  });

  it('opens the home directory when its shorthand is complete', () => {
    expect(splitDirectoryInput('~')).toEqual({
      directory: '~/',
      base: '~/',
      prefix: '',
      separator: '/',
    });
  });

  it('opens a Windows drive root when its colon is complete', () => {
    expect(splitDirectoryInput('C:')).toEqual({
      directory: 'C:\\',
      base: 'C:\\',
      prefix: '',
      separator: '\\',
    });
  });
});

describe('directory argument completion', () => {
  it('lists against the session working directory and filters by prefix', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useDirectoryCompletion(command(), 's', 'C:\\repo', onError));

    await waitFor(() => expect(result.current.map((entry) => entry.name)).toEqual(['Source', 'src']));
    expect(listDirectories).toHaveBeenCalledWith('C:\\repo', '');
    expect(result.current[0]).toEqual({ name: 'Source', path: 'Source', separator: '\\' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('reads a parent once while the final segment is typed', async () => {
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ input }) => useDirectoryCompletion(command(), input, 'C:\\repo', onError),
      { initialProps: { input: 'src\\' } },
    );
    await waitFor(() => expect(result.current).toHaveLength(4));

    rerender({ input: 'src\\S' });
    expect(result.current.map((entry) => entry.path)).toEqual(['src\\Source', 'src\\src']);
    expect(listDirectories).toHaveBeenCalledTimes(1);
    expect(listDirectories).toHaveBeenCalledWith('C:\\repo', 'src\\');
  });

  it('respects case-sensitive filesystems', async () => {
    listDirectories.mockResolvedValue({
      entries: ['Source', 'src'],
      separator: '/',
      caseSensitive: true,
    });
    const { result } = renderHook(() => useDirectoryCompletion(command(), 's', '/repo', vi.fn()));

    await waitFor(() => expect(result.current.map((entry) => entry.name)).toEqual(['src']));
  });

  it('does not list for a command without the runtime completion hint', () => {
    const { result } = renderHook(() => useDirectoryCompletion(command(false), '', 'C:\\repo', vi.fn()));

    expect(result.current).toEqual([]);
    expect(listDirectories).not.toHaveBeenCalled();
  });

  it('does not list until the command argument has begun', () => {
    renderHook(() => useDirectoryCompletion(command(), null, 'C:\\repo', vi.fn()));
    expect(listDirectories).not.toHaveBeenCalled();
  });

  it('does not let a slower previous directory replace the current one', async () => {
    let answerFirst!: (value: unknown) => void;
    listDirectories
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({
        entries: ['current'],
        separator: '\\',
        caseSensitive: false,
      });

    const { result, rerender } = renderHook(
      ({ input }) => useDirectoryCompletion(command(), input, 'C:\\repo', vi.fn()),
      { initialProps: { input: 'first\\' } },
    );
    rerender({ input: 'second\\' });
    await waitFor(() => expect(result.current.map((entry) => entry.name)).toEqual(['current']));

    await act(async () => {
      answerFirst({ entries: ['stale'], separator: '\\', caseSensitive: false });
    });
    expect(result.current.map((entry) => entry.name)).toEqual(['current']);
  });

  it('reports a filesystem failure instead of making it look empty', async () => {
    listDirectories.mockRejectedValue(new Error('access denied'));
    const onError = vi.fn();
    renderHook(() => useDirectoryCompletion(command(), '', 'C:\\repo', onError));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Could not list directories: access denied'));
  });
});
