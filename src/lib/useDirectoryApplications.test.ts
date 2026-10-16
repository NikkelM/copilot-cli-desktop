// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDirectoryApplications } from './useDirectoryApplications';
import { directoryApplications, openDirectory } from './sidecar';
import type { DirectoryApplication } from '../../shared/directoryApplications';

vi.mock('./sidecar', () => ({ directoryApplications: vi.fn(), openDirectory: vi.fn() }));
beforeEach(() => {
  vi.mocked(directoryApplications).mockReset().mockResolvedValue([{ id: 'folder', label: 'File Explorer' }]);
  vi.mocked(openDirectory).mockReset().mockResolvedValue(undefined);
});

describe('working directory application choices', () => {
  it('discovers once and reuses the list when only the preferred target changes', async () => {
    const report = vi.fn();
    const view = renderHook(({ target }) => useDirectoryApplications('[]', target, report), {
      initialProps: { target: 'folder' },
    });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    view.rerender({ target: 'editor' });
    expect(directoryApplications).toHaveBeenCalledExactlyOnceWith('[]');
    act(() => view.result.current.open('C:\\repo'));
    expect(openDirectory).toHaveBeenCalledExactlyOnceWith('C:\\repo', 'editor', '[]');
  });

  it('ignores stale discovery answers after custom targets change', async () => {
    let answer = (_apps: DirectoryApplication[]) => {};
    vi.mocked(directoryApplications).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const view = renderHook(({ custom }) => useDirectoryApplications(custom, 'folder', vi.fn()), {
      initialProps: { custom: 'old' },
    });
    view.rerender({ custom: 'new' });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => answer([{ id: 'stale', label: 'Old' }]));
    expect(view.result.current.applications).toEqual([{ id: 'folder', label: 'File Explorer' }]);
  });

  it('reports discovery and launch failures explicitly', async () => {
    vi.mocked(directoryApplications).mockRejectedValue(new Error('Discovery failed'));
    const report = vi.fn();
    const view = renderHook(() => useDirectoryApplications('[]', 'folder', report));
    await waitFor(() => expect(view.result.current.error).toBe('Discovery failed'));
    vi.mocked(openDirectory).mockRejectedValue(new Error('Editor removed'));
    act(() => view.result.current.open('C:\\repo'));
    await waitFor(() => expect(report).toHaveBeenCalledWith('Editor removed'));
  });
});
