// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appUpdateStatus, checkAppUpdate, downloadAppUpdate, installAppUpdate, onAppUpdate, updateBlockReason } from './appUpdates';

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({});
  listen.mockReset().mockResolvedValue(() => undefined);
});

describe('native updater bridge', () => {
  it('uses the dedicated native updater commands rather than starting a CLI session', async () => {
    await appUpdateStatus();
    await checkAppUpdate();
    await downloadAppUpdate();
    await installAppUpdate();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'app_update_status', 'app_update_check', 'app_update_download', 'app_update_install',
    ]);
    await onAppUpdate(vi.fn());
    expect(listen).toHaveBeenCalledWith('app-update', expect.any(Function));
  });
});

describe('safe update installation', () => {
  const idle = {
    working: false, loading: false, questions: false, agents: false,
    queued: false, unsent: false, wiki: false, saving: false,
  };

  it('allows an idle app with no unpreserved work', () => {
    expect(updateBlockReason(idle)).toBeNull();
  });

  it.each(Object.keys(idle) as (keyof typeof idle)[])('blocks installation while %s is present', (field) => {
    expect(updateBlockReason({ ...idle, [field]: true })).toBeTruthy();
  });
});
