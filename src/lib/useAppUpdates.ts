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
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [offerRollback, setOfferRollback] = useState(false);
  const pendingRollbackOffer = useRef(false);
  const suppressRollbackOffer = useRef(false);
  const previousChannel = useRef(includePrereleases);
  const current = useRef<AppUpdateStatus | null>(null);
  const running = useRef(false);
  const started = useRef(false);
  const latest = useRef({ autoDownload, blocked, includePrereleases, onStable });
  latest.current = { autoDownload, blocked, includePrereleases, onStable };

  const accept = useCallback((next: AppUpdateStatus) => {
    if (current.current && next.revision < current.current.revision) return;
    current.current = next;
    setStatus(next);
  }, []);
  useTauriEvent(() => onAppUpdate(accept), [accept]);

  const check = useCallback(async (manual = true) => {
    if (running.current || (current.current && current.current.action !== 'idle')) return;
    if (manual) started.current = true;
    running.current = true;
    setBusy(true);
    setFailed(null);
    try {
      const found = await checkAppUpdate(
        latest.current.includePrereleases,
        !!current.current?.rollback && !latest.current.includePrereleases,
      );
      accept(found);
      const seen = current.current;
      if (
        seen?.action === 'idle' && seen.available && !seen.ready
        && seen.includePrereleases === latest.current.includePrereleases
        && (manual || latest.current.autoDownload)
      ) {
        accept(await downloadAppUpdate());
      }
    } catch (error) {
      setFailed(messageOf(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [accept]);

  const download = useCallback(async () => {
    if (running.current || !current.current?.available || current.current.ready || current.current.action !== 'idle') return;
    if (current.current.available.prerelease && !latest.current.includePrereleases) {
      setFailed('Prerelease updates are disabled. Check for a stable release instead.');
      return;
    }
    running.current = true;
    setBusy(true);
    setFailed(null);
    try {
      accept(await downloadAppUpdate());
    } catch (error) {
      setFailed(messageOf(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [accept]);

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
      if (!includePrereleases && !suppressRollbackOffer.current) pendingRollbackOffer.current = true;
      suppressRollbackOffer.current = false;
      previousChannel.current = includePrereleases;
      setFailed(null);
    }
    if (
      started.current && status?.action === 'idle' && !busy && !running.current && !failed
      && status.includePrereleases !== includePrereleases
    ) {
      void check(false);
    }
    if (
      pendingRollbackOffer.current && status?.action === 'idle'
      && status.includePrereleases === false && !busy && !running.current
    ) {
      pendingRollbackOffer.current = false;
      if (status.currentPrerelease && status.stableVersion) setOfferRollback(true);
    }
  }, [includePrereleases, status, busy, failed, check]);

  useEffect(() => {
    if (
      autoDownload && status?.action === 'idle' && status.available && !status.ready
      && status.includePrereleases === includePrereleases
      && !status.error && !failed && !running.current
    ) {
      void download();
    }
  }, [autoDownload, includePrereleases, status, failed, busy, download]);

  useEffect(() => {
    let live = true;
    void appUpdateStatus()
      .then((found) => {
        if (!live) return;
        accept(found);
        if (!started.current) {
          started.current = true;
          void check(false);
        }
      })
      .catch((error: unknown) => {
        if (live) setFailed(messageOf(error));
      });
    return () => { live = false; };
  }, [accept, check]);

  return {
    status, busy, installing, installFailed, offerRollback,
    failed: failed ?? status?.error ?? null,
    blocked,
    showNotice: !!status?.ready && status.installSupported && dismissed !== status.available?.version
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
