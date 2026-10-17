// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, StrictMode, useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppUpdateStatus } from './appUpdates';
import { useAppUpdates } from './useAppUpdates';

const api = vi.hoisted(() => ({
  appUpdateStatus: vi.fn(), checkAppUpdate: vi.fn(), downloadAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(), onAppUpdate: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ prepareAppUpdate: vi.fn(), cancelAppUpdate: vi.fn() }));
const { flushStores, save } = vi.hoisted(() => ({ flushStores: vi.fn(), save: vi.fn() }));
vi.mock('./appUpdates', () => api);
vi.mock('./sidecar', () => runtime);
vi.mock('./store', () => ({ flushStores, save }));

const state = (over: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  revision: 0, currentVersion: '1.0.0', currentRelease: null, action: 'idle', available: null,
  ready: false, downloaded: 0, total: null, checkedAt: null, error: null,
  installSupported: true,
  currentPrerelease: false, includePrereleases: false, stableVersion: '2.0.0', rollback: false,
  ...over,
});
const available = () => state({
  revision: 2, available: { version: '2.0.0', notes: 'New release', prerelease: false }, checkedAt: '2026-10-16T10:00:00Z',
});
const ready = () => ({ ...available(), revision: 4, ready: true, downloaded: 1024, total: 1024 });
const listeners = new Set<(status: AppUpdateStatus) => void>();
const emit = (status: AppUpdateStatus) => act(() => { for (const listener of listeners) listener(status); });
const watching = (autoDownload = true, blocked: string | null = null) =>
  renderHook(({ auto, blocked }: { auto: boolean; blocked: string | null }) => useAppUpdates(auto, blocked, false, vi.fn()), {
    initialProps: { auto: autoDownload, blocked },
  });

beforeEach(() => {
  listeners.clear();
  api.appUpdateStatus.mockReset().mockResolvedValue(state());
  api.checkAppUpdate.mockReset().mockResolvedValue(available());
  api.downloadAppUpdate.mockReset().mockResolvedValue(ready());
  api.installAppUpdate.mockReset().mockResolvedValue(state({ revision: 6 }));
  api.onAppUpdate.mockReset().mockImplementation((listener) => {
    listeners.add(listener);
    return Promise.resolve(() => listeners.delete(listener));
  });
  runtime.prepareAppUpdate.mockReset().mockResolvedValue(undefined);
  runtime.cancelAppUpdate.mockReset().mockResolvedValue(undefined);
  flushStores.mockReset().mockResolvedValue(undefined);
  save.mockReset();
});

describe('desktop app updates', () => {
  it('can recover with a manual check after the initial status request fails', async () => {
    api.appUpdateStatus.mockRejectedValue(new Error('Status unavailable'));
    const view = watching();
    await waitFor(() => expect(view.result.current.failed).toBe('Status unavailable'));
    await act(async () => { await view.result.current.check(); });
    expect(view.result.current.status?.available?.version).toBe('2.0.0');
    expect(view.result.current.status?.ready).toBe(false);
    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    expect(api.downloadAppUpdate).not.toHaveBeenCalled();
    expect(view.result.current.failed).toBeNull();
  });

  describe('prerelease update channels', () => {
    const channelState = (include = true, rollback = false, revision = 1): AppUpdateStatus => state({
      revision, currentVersion: '2.1.0-beta.3', currentPrerelease: true,
      includePrereleases: include, stableVersion: '2.0.0', rollback,
      available: rollback
        ? { version: '2.0.0', notes: 'Stable', prerelease: false }
        : include ? { version: '2.1.0-beta.4', notes: 'Preview', prerelease: true } : null,
    });
    const mounted = (initial = true, auto = false) => renderHook(() => {
      const [include, setInclude] = useState(initial);
      return {
        updates: useAppUpdates(auto, null, include, () => setInclude(false)),
        setInclude, include,
      };
    });

    beforeEach(() => {
      let revision = 1;
      let found = channelState();
      api.appUpdateStatus.mockResolvedValue(found);
      api.checkAppUpdate.mockImplementation(async (include, rollback) => {
        found = channelState(include, rollback, ++revision);
        return found;
      });
      api.downloadAppUpdate.mockImplementation(async () => {
        found = { ...found, revision: ++revision, ready: true };
        return found;
      });
    });

    it('checks the saved opt-in channel and can download a newer prerelease', async () => {
      const view = mounted();
      await waitFor(() => expect(view.result.current.updates.status?.available?.prerelease).toBe(true));
      expect(api.checkAppUpdate).toHaveBeenCalledExactlyOnceWith(true, false);
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
      await act(async () => { await view.result.current.updates.download(); });
      expect(view.result.current.updates.status?.ready).toBe(true);
      expect(api.installAppUpdate).not.toHaveBeenCalled();
    });

    it('checks an unsaved displayed channel without changing the saved preference', async () => {
      const view = mounted(false);
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledWith(false, false));
      api.checkAppUpdate.mockClear();

      await act(async () => { await view.result.current.updates.selectChannel(true); });

      expect(view.result.current.include).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(api.checkAppUpdate).toHaveBeenCalledExactlyOnceWith(true, false);
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
      expect(view.result.current.updates.status?.includePrereleases).toBe(true);
    });

    it('commits an already-checked displayed channel without checking it twice', async () => {
      const view = mounted(false);
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledWith(false, false));
      api.checkAppUpdate.mockClear();
      await act(async () => { await view.result.current.updates.selectChannel(true); });
      expect(api.checkAppUpdate).toHaveBeenCalledOnce();

      act(() => view.result.current.setInclude(true));
      await act(async () => { await Promise.resolve(); });

      expect(view.result.current.include).toBe(true);
      expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    });

    it('manual checking only discovers from the displayed channel', async () => {
      const view = mounted(false, true);
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledWith(false, false));
      api.checkAppUpdate.mockClear();

      await act(async () => { await view.result.current.updates.check(true); });

      expect(api.checkAppUpdate).toHaveBeenCalledExactlyOnceWith(true, false);
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
      expect(view.result.current.updates.status?.available?.prerelease).toBe(true);
      expect(view.result.current.updates.status?.ready).toBe(false);
      expect(view.result.current.updates.showNotice).toBe(false);
    });

    it('queues the newest displayed channel while another selection is still checking', async () => {
      let finish!: (status: AppUpdateStatus) => void;
      api.checkAppUpdate.mockReturnValueOnce(new Promise<AppUpdateStatus>((resolve) => { finish = resolve; }));
      const view = mounted(false);
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce());

      act(() => {
        void view.result.current.updates.selectChannel(true);
        void view.result.current.updates.selectChannel(false);
      });
      await act(async () => finish(channelState(false)));
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledTimes(2));

      expect(api.checkAppUpdate).toHaveBeenLastCalledWith(false, false);
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
    });

    it('offers a confirmed stable return after opt-out without automatically downgrading', async () => {
      const view = mounted();
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce());
      act(() => view.result.current.setInclude(false));
      await waitFor(() => expect(view.result.current.updates.offerRollback).toBe(true));
      expect(api.checkAppUpdate).toHaveBeenLastCalledWith(false, false);
      expect(view.result.current.updates.status?.available).toBeNull();
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
      expect(api.installAppUpdate).not.toHaveBeenCalled();
      act(() => view.result.current.updates.dismissRollback());
      expect(view.result.current.updates.offerRollback).toBe(false);
    });

    it('disables prereleases and stages the latest stable only after confirmation', async () => {
      const view = mounted();
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce());
      act(() => view.result.current.updates.requestStable());
      expect(view.result.current.updates.offerRollback).toBe(true);
      expect(api.checkAppUpdate).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
      await act(async () => { await view.result.current.updates.returnToStable(); });
      expect(view.result.current.include).toBe(false);
      expect(save).toHaveBeenCalledWith('settings', 'appIncludePrereleases', 'false');
      expect(api.checkAppUpdate).toHaveBeenLastCalledWith(false, true);
      expect(view.result.current.updates.status).toMatchObject({
        ready: true, rollback: true, includePrereleases: false,
        available: { version: '2.0.0', prerelease: false },
      });
      expect(view.result.current.updates.offerRollback).toBe(false);
      expect(api.installAppUpdate).not.toHaveBeenCalled();
      await act(async () => { await view.result.current.updates.check(); });
      expect(api.checkAppUpdate).toHaveBeenLastCalledWith(false, true);
    });

    it('does not offer a downgrade merely because a stable user disables prereleases', async () => {
      api.checkAppUpdate.mockImplementation(async (include) => ({
        ...channelState(include), currentVersion: '2.0.0', currentPrerelease: false,
      }));
      const view = mounted();
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce());
      act(() => view.result.current.setInclude(false));
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledTimes(2));
      expect(view.result.current.updates.offerRollback).toBe(false);
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
    });

    it('does not download a stale prerelease result after the user opts out', async () => {
      let finish!: (status: AppUpdateStatus) => void;
      api.checkAppUpdate.mockReturnValueOnce(new Promise<AppUpdateStatus>((resolve) => { finish = resolve; }));
      const view = mounted(true, true);
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce());
      act(() => view.result.current.setInclude(false));
      await act(async () => finish(channelState(true)));
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenLastCalledWith(false, false));
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
      expect(view.result.current.updates.showNotice).toBe(false);
    });

    it('does not offer an unavailable stable rollback and keeps a failed selection retryable', async () => {
      api.checkAppUpdate.mockImplementation(async (include, rollback) => {
        if (rollback) throw new Error('No stable release is published');
        return { ...channelState(include), stableVersion: null };
      });
      const view = mounted();
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce());
      act(() => view.result.current.setInclude(false));
      await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledTimes(2));
      expect(view.result.current.updates.offerRollback).toBe(false);
      await act(async () => { await view.result.current.updates.returnToStable(); });
      expect(view.result.current.updates.failed).toBe('No stable release is published');
      expect(view.result.current.updates.busy).toBe(false);
      expect(api.downloadAppUpdate).not.toHaveBeenCalled();
    });
  });

  it('checks at startup, downloads automatically, and never installs without a user action', async () => {
    const view = watching();
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));

    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce();
    expect(api.installAppUpdate).not.toHaveBeenCalled();
    expect(runtime.prepareAppUpdate).not.toHaveBeenCalled();
    expect(view.result.current.showNotice).toBe(true);
  });

  it('keeps manual checking separate from downloading when automatic downloads are disabled', async () => {
    const view = watching(false);
    await waitFor(() => expect(view.result.current.status?.available?.version).toBe('2.0.0'));
    expect(api.downloadAppUpdate).not.toHaveBeenCalled();

    await act(async () => { await view.result.current.check(); });
    expect(api.checkAppUpdate).toHaveBeenCalledTimes(2);
    expect(api.downloadAppUpdate).not.toHaveBeenCalled();
    expect(view.result.current.status?.ready).toBe(false);

    await act(async () => { await view.result.current.download(); });
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce();
    expect(view.result.current.status?.ready).toBe(true);
    expect(view.result.current.showNotice).toBe(false);
  });

  it('allows downloading an already-found update without repeating the check', async () => {
    const view = watching(false);
    await waitFor(() => expect(view.result.current.status?.available).toBeTruthy());
    await act(async () => { await view.result.current.download(); });
    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce();
  });

  it('honours a changed download preference while a check is in flight', async () => {
    let answer!: (status: AppUpdateStatus) => void;
    api.checkAppUpdate.mockReturnValue(new Promise<AppUpdateStatus>((resolve) => { answer = resolve; }));
    const view = watching(true);
    await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce());
    view.rerender({ auto: false, blocked: null });
    await act(async () => answer(available()));
    expect(api.downloadAppUpdate).not.toHaveBeenCalled();
  });

  it('does not repeat checks or leak progress listeners in StrictMode', async () => {
    const view = renderHook(() => useAppUpdates(true, null, false, vi.fn()), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
    });
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(1);
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(listeners.size).toBe(0);
  });

  it('ignores stale progress and does not redownload a newer acknowledged snapshot', async () => {
    let answer!: (status: AppUpdateStatus) => void;
    api.checkAppUpdate.mockReturnValue(new Promise<AppUpdateStatus>((resolve) => { answer = resolve; }));
    const view = watching();
    await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce());
    emit(ready());
    await act(async () => answer(available()));
    expect(api.downloadAppUpdate).not.toHaveBeenCalled();
    emit({ ...available(), action: 'downloading', downloaded: 1 });
    expect(view.result.current.status?.ready).toBe(true);
    expect(view.result.current.status?.downloaded).toBe(1024);
  });

  it('does not retry failed background downloads in a loop', async () => {
    api.downloadAppUpdate.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue(ready());
    const view = watching();
    await waitFor(() => expect(view.result.current.failed).toBe('network unavailable'));
    await act(async () => { await Promise.resolve(); });
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce();
    expect(view.result.current.busy).toBe(false);
  });

  it('resumes automatic downloading after an already-running native check completes', async () => {
    api.appUpdateStatus.mockResolvedValue(state({ revision: 1, action: 'checking' }));
    const view = watching();
    await waitFor(() => expect(listeners.size).toBe(1));
    await waitFor(() => expect(view.result.current.status?.action).toBe('checking'));
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    emit(available());
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce();
    expect(view.result.current.showNotice).toBe(true);
  });

  it('prepares the runtime and flushes stores before invoking the installer', async () => {
    const calls: string[] = [];
    runtime.prepareAppUpdate.mockImplementation(async () => { calls.push('prepare'); });
    flushStores.mockImplementation(async () => { calls.push('flush'); });
    api.installAppUpdate.mockImplementation(async () => {
      calls.push('install');
      return state({ revision: 6 });
    });
    const view = watching();
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    await act(async () => { await view.result.current.install(); });
    expect(calls).toEqual(['prepare', 'flush', 'install']);
    expect(runtime.cancelAppUpdate).not.toHaveBeenCalled();
  });

  it('refuses installation when work or unsaved content blocks it', async () => {
    const view = watching(true, 'Save your wiki edits first');
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    await act(async () => { await view.result.current.install(); });
    expect(view.result.current.failed).toBe('Save your wiki edits first');
    expect(runtime.prepareAppUpdate).not.toHaveBeenCalled();
    expect(api.installAppUpdate).not.toHaveBeenCalled();
  });

  it('does not install from the development build', async () => {
    api.downloadAppUpdate.mockResolvedValue({ ...ready(), installSupported: false });
    const view = watching();
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    await act(async () => { await view.result.current.install(); });
    expect(view.result.current.failed).toContain('installed Windows build');
    expect(api.installAppUpdate).not.toHaveBeenCalled();
    expect(view.result.current.showNotice).toBe(false);
  });

  it('does not install or unlock another update when runtime preparation fails', async () => {
    runtime.prepareAppUpdate.mockRejectedValue(new Error('sessions are working'));
    const view = watching();
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    await act(async () => { await view.result.current.install(); });
    expect(api.installAppUpdate).not.toHaveBeenCalled();
    expect(flushStores).not.toHaveBeenCalled();
    expect(runtime.cancelAppUpdate).not.toHaveBeenCalled();
    expect(view.result.current.failed).toBe('sessions are working');
  });

  it('restores the runtime if flushing or installation fails', async () => {
    flushStores.mockRejectedValue(new Error('disk full'));
    const view = watching();
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    await act(async () => { await view.result.current.install(); });
    expect(api.installAppUpdate).not.toHaveBeenCalled();
    expect(runtime.cancelAppUpdate).toHaveBeenCalledOnce();
    expect(view.result.current.failed).toBe('disk full');
    expect(view.result.current.installing).toBe(false);

    flushStores.mockResolvedValue(undefined);
    api.installAppUpdate.mockRejectedValue(new Error('installer failed'));
    await act(async () => { await view.result.current.install(); });
    expect(runtime.cancelAppUpdate).toHaveBeenCalledTimes(2);
    expect(view.result.current.failed).toBe('installer failed');
    expect(view.result.current.installFailed).toBe('installer failed');
    act(() => view.result.current.dismiss());
    expect(view.result.current.installFailed).toBeNull();
  });

  it('reports a failed runtime restoration instead of silently leaving it locked', async () => {
    api.installAppUpdate.mockRejectedValue(new Error('installer failed'));
    runtime.cancelAppUpdate.mockRejectedValue(new Error('runtime unavailable'));
    const view = watching();
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    await act(async () => { await view.result.current.install(); });
    expect(view.result.current.failed).toContain('installer failed');
    expect(view.result.current.failed).toContain('runtime unavailable');
  });

  it('ignores repeated install clicks while preparation is in flight', async () => {
    let answer!: () => void;
    runtime.prepareAppUpdate.mockReturnValue(new Promise<void>((resolve) => { answer = resolve; }));
    const view = watching();
    await waitFor(() => expect(view.result.current.status?.ready).toBe(true));
    act(() => {
      void view.result.current.install();
      void view.result.current.install();
    });
    expect(runtime.prepareAppUpdate).toHaveBeenCalledOnce();
    expect(view.result.current.installing).toBe(true);
    await act(async () => answer());
    expect(api.installAppUpdate).toHaveBeenCalledOnce();
  });

  it('does not reopen a dismissed startup prompt for unrelated ready events', async () => {
    const view = watching();
    await waitFor(() => expect(view.result.current.showNotice).toBe(true));
    act(() => view.result.current.dismiss());
    emit({ ...ready(), revision: 5 });
    expect(view.result.current.showNotice).toBe(false);
    emit({ ...ready(), revision: 6, available: { version: '3.0.0', notes: null, prerelease: false } });
    expect(view.result.current.showNotice).toBe(false);
  });
});
