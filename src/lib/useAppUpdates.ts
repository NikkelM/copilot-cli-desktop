import { useCallback, useEffect, useRef, useState } from 'react';

import {
  appUpdateStatus, checkAppUpdate, downloadAppUpdate, installAppUpdate, onAppUpdate,
  type AppUpdateStatus,
} from './appUpdates';
import { cancelAppUpdate, prepareAppUpdate } from './sidecar';
import { flushStores, save } from './store';
import { APP_INCLUDE_PRERELEASES } from './useSettings';
import { messageOf } from './errors';
import { useTauriEvent } from './useTauriEvent';

interface CheckRequest {
  includePrereleases: boolean;
  downloadAutomatically: boolean;
  promptAfterDownload: boolean;
}

export function useAppUpdates(
  autoDownload: boolean,
  blocked: string | null,
  includePrereleases: boolean,
  onStable: () => void,
) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installFailed, setInstallFailed] = useState<string | null>(null);
  const [prompted, setPrompted] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [offerRollback, setOfferRollback] = useState(false);
  const pendingRollbackOffer = useRef(false);
  const suppressRollbackOffer = useRef(false);
  const previousChannel = useRef(includePrereleases);
  const current = useRef<AppUpdateStatus | null>(null);
  const running = useRef(false);
  const queuedCheck = useRef<CheckRequest | null>(null);
  const automaticDownloadPending = useRef(false);
  const started = useRef(false);
  const startupPrompt = useRef(true);
  const latest = useRef({ autoDownload, blocked, includePrereleases, onStable });
  latest.current = { autoDownload, blocked, includePrereleases, onStable };

  const accept = useCallback((next: AppUpdateStatus) => {
    if (current.current && next.revision < current.current.revision) return;
    current.current = next;
    setStatus(next);
    if (startupPrompt.current && next.ready && next.available) {
      startupPrompt.current = false;
      setPrompted(next.available.version);
    }
  }, []);
  useTauriEvent(() => onAppUpdate(accept), [accept]);

  const runCheck = useCallback(async (request: CheckRequest) => {
    running.current = true;
    setBusy(true);
    setFailed(null);
    try {
      const found = await checkAppUpdate(
        request.includePrereleases,
        !!current.current?.rollback && !request.includePrereleases,
      );
      accept(found);
      const seen = current.current;
      if (
        !queuedCheck.current && seen?.action === 'idle' && seen.available && !seen.ready
        && seen.includePrereleases === request.includePrereleases
        && request.downloadAutomatically && latest.current.autoDownload
      ) {
        automaticDownloadPending.current = false;
        accept(await downloadAppUpdate());
        if (request.promptAfterDownload && current.current?.available) {
          setPrompted(current.current.available.version);
        }
      } else if (!queuedCheck.current) {
        automaticDownloadPending.current = false;
        if (request.promptAfterDownload) startupPrompt.current = false;
      }
    } catch (error) {
      setFailed(messageOf(error));
      if (!queuedCheck.current) {
        automaticDownloadPending.current = false;
        if (request.promptAfterDownload) startupPrompt.current = false;
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [accept]);

  const requestCheck = useCallback((request: CheckRequest): Promise<void> => {
    queuedCheck.current = request;
    automaticDownloadPending.current = request.downloadAutomatically;
    if (running.current || (current.current && current.current.action !== 'idle')) return Promise.resolve();
    queuedCheck.current = null;
    return runCheck(request);
  }, [runCheck]);

  const check = useCallback((channel = latest.current.includePrereleases) => {
    started.current = true;
    startupPrompt.current = false;
    return requestCheck({
      includePrereleases: channel,
      downloadAutomatically: false,
      promptAfterDownload: false,
    });
  }, [requestCheck]);

  const runDownload = useCallback(async (channel: boolean, prompt: boolean) => {
    if (running.current || !current.current?.available || current.current.ready || current.current.action !== 'idle') return;
    if (current.current.available.prerelease && !channel) {
      setFailed('Prerelease updates are disabled. Check for a stable release instead.');
      return;
    }
    running.current = true;
    setBusy(true);
    setFailed(null);
    try {
      accept(await downloadAppUpdate());
      if (prompt && current.current?.available) setPrompted(current.current.available.version);
    } catch (error) {
      setFailed(messageOf(error));
      if (prompt) startupPrompt.current = false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [accept]);

  const download = useCallback((channel = latest.current.includePrereleases) => {
    startupPrompt.current = false;
    return runDownload(channel, false);
  }, [runDownload]);

  const install = useCallback(async () => {
    if (running.current || !current.current?.ready || current.current.action !== 'idle') return;
    if (!current.current.installSupported) {
      setFailed('Install app updates from an installed Windows build, not the development app.');
      return;
    }
    if (latest.current.blocked) {
      setFailed(latest.current.blocked);
      return;
    }
    if (current.current.available?.prerelease && !latest.current.includePrereleases) {
      setFailed('Prerelease updates are disabled. Check for a stable release instead.');
      return;
    }
    if (current.current.rollback && latest.current.includePrereleases) {
      setFailed('Check for updates in the prerelease channel before installing.');
      return;
    }
    running.current = true;
    setBusy(true);
    setInstalling(true);
    setInstallFailed(null);
    setFailed(null);
    let prepared = false;
    try {
      await prepareAppUpdate();
      prepared = true;
      await flushStores();
      accept(await installAppUpdate());
    } catch (error) {
      let detail = messageOf(error);
      if (prepared) {
        try {
          await cancelAppUpdate();
        } catch (restoreError) {
          detail += ` The session runtime could not be restored: ${messageOf(restoreError)}`;
        }
      }
      setFailed(detail);
      setInstallFailed(detail);
    } finally {
      running.current = false;
      setInstalling(false);
      setBusy(false);
    }
  }, [accept]);

  const returnToStable = useCallback(async () => {
    if (running.current || !current.current?.currentPrerelease || current.current.action !== 'idle') return;
    suppressRollbackOffer.current = true;
    pendingRollbackOffer.current = false;
    setOfferRollback(false);
    running.current = true;
    setBusy(true);
    setFailed(null);
    try {
      latest.current.onStable();
      // Persist the channel before staging a rollback that can install on the next launch
      save('settings', APP_INCLUDE_PRERELEASES, 'false');
      latest.current.includePrereleases = false;
      if (!current.current?.available || current.current.available.prerelease) {
        accept(await checkAppUpdate(false, true));
      }
      if (current.current?.available && !current.current.ready) {
        accept(await downloadAppUpdate());
      }
    } catch (error) {
      setFailed(messageOf(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [accept]);

  useEffect(() => {
    if (previousChannel.current !== includePrereleases) {
      const handledByStableReturn = suppressRollbackOffer.current;
      if (!includePrereleases && !handledByStableReturn) pendingRollbackOffer.current = true;
      suppressRollbackOffer.current = false;
      previousChannel.current = includePrereleases;
      setFailed(null);
      if (
        started.current && !handledByStableReturn
        && current.current?.includePrereleases !== includePrereleases
      ) {
        void requestCheck({
          includePrereleases,
          downloadAutomatically: false,
          promptAfterDownload: false,
        });
      }
    }
  }, [includePrereleases, requestCheck]);

  useEffect(() => {
    if (
      pendingRollbackOffer.current && status?.action === 'idle'
      && status.includePrereleases === false && !busy && !running.current
    ) {
      pendingRollbackOffer.current = false;
      if (status.currentPrerelease && status.stableVersion) setOfferRollback(true);
    }
  }, [status, busy]);

  useEffect(() => {
    if (busy || running.current || status?.action !== 'idle' || !queuedCheck.current) return;
    const request = queuedCheck.current;
    queuedCheck.current = null;
    void runCheck(request);
  }, [busy, status?.action, runCheck]);

  useEffect(() => {
    if (
      automaticDownloadPending.current && autoDownload
      && status?.action === 'idle' && status.available && !status.ready
      && status.includePrereleases === includePrereleases
      && !status.error && !failed && !running.current
    ) {
      automaticDownloadPending.current = false;
      void runDownload(includePrereleases, startupPrompt.current);
    }
  }, [autoDownload, includePrereleases, status, failed, busy, runDownload]);

  useEffect(() => {
    if (
      startupPrompt.current && status?.action === 'idle' && status.checkedAt
      && (!status.available || !autoDownload)
    ) {
      startupPrompt.current = false;
    }
  }, [autoDownload, status]);

  useEffect(() => {
    let live = true;
    void appUpdateStatus()
      .then((found) => {
        if (!live) return;
        accept(found);
        if (!started.current) {
          started.current = true;
          if (found.action === 'idle') {
            void requestCheck({
              includePrereleases: latest.current.includePrereleases,
              downloadAutomatically: true,
              promptAfterDownload: true,
            });
          } else {
            automaticDownloadPending.current = true;
          }
        }
      })
      .catch((error: unknown) => {
        if (live) setFailed(messageOf(error));
      });
    return () => { live = false; };
  }, [accept, requestCheck]);

  return {
    status, busy, installing, installFailed, offerRollback,
    failed: failed ?? status?.error ?? null,
    blocked,
    showNotice: !!status?.ready && status.installSupported && prompted === status.available?.version
      && dismissed !== status.available?.version
      && (!status.available?.prerelease || includePrereleases)
      && (!status.rollback || !includePrereleases),
    check, download, install,
    requestStable: () => setOfferRollback(true),
    returnToStable,
    dismissRollback: () => setOfferRollback(false),
    dismiss: () => {
      setDismissed(current.current?.available?.version ?? null);
      setInstallFailed(null);
    },
  };
}

export type AppUpdates = ReturnType<typeof useAppUpdates>;
