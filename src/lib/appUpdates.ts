import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface AppUpdateStatus {
  revision: number;
  currentVersion: string;
  currentRelease: { version: string; notes: string | null; prerelease: boolean } | null;
  action: 'idle' | 'checking' | 'downloading' | 'installing';
  available: { version: string; notes: string | null; prerelease: boolean } | null;
  ready: boolean;
  downloaded: number;
  total: number | null;
  checkedAt: string | null;
  error: string | null;
  installSupported: boolean;
  currentPrerelease: boolean;
  includePrereleases: boolean;
  stableVersion: string | null;
  rollback: boolean;
}

export const appUpdateStatus = () => invoke<AppUpdateStatus>('app_update_status');
export const checkAppUpdate = (includePrereleases = false, rollback = false) =>
  invoke<AppUpdateStatus>('app_update_check', { includePrereleases, rollback });
export const downloadAppUpdate = () => invoke<AppUpdateStatus>('app_update_download');
export const installAppUpdate = () => invoke<AppUpdateStatus>('app_update_install');
export const onAppUpdate = (handler: (status: AppUpdateStatus) => void) =>
  listen<AppUpdateStatus>('app-update', (event) => handler(event.payload));

export function updateBlockReason(state: {
  working: boolean;
  loading: boolean;
  questions: boolean;
  agents: boolean;
  queued: boolean;
  unsent: boolean;
  wiki: boolean;
  saving: boolean;
}): string | null {
  if (state.working || state.loading || state.questions || state.agents || state.saving) {
    return 'Wait for running sessions, subagents, questions and saves to finish before installing.';
  }
  if (state.queued) return 'Send or clear queued messages before installing.';
  if (state.unsent) return 'Send or clear unsent and stashed prompts and attachments before installing.';
  if (state.wiki) return 'Save or discard your wiki edits before installing.';
  return null;
}
