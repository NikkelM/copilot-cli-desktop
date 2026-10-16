import { useState } from 'react';
import { createPortal } from 'react-dom';
import { appLogDir } from '@tauri-apps/api/path';
import { openPath } from '@tauri-apps/plugin-opener';

import type { AppUpdates } from '../lib/useAppUpdates';
import { messageOf } from '../lib/errors';
import { bytes } from '../lib/units';
import { formatRelative } from '../lib/time';
import { Markdown } from './Markdown';
import { Confirm } from './Confirm';

export function AppUpdateSettings({
  updates, dirty, includePrereleases, shows,
}: {
  updates?: AppUpdates;
  dirty: boolean;
  includePrereleases: boolean;
  shows: (label: string) => boolean;
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const status = updates?.status;
  const busy = updates?.busy || (!!status && status.action !== 'idle');
  const blocked = dirty ? 'Save or discard your settings changes before installing.' : updates?.blocked;
  const installReason = !status?.installSupported
    ? 'Installation is available in an installed Windows build.'
    : blocked;
  let detail = 'Reading app version...';
  if (status?.action === 'checking') detail = 'Checking for updates...';
  else if (status?.action === 'downloading') {
    detail = `Downloading ${bytes(status.downloaded)}${status.total ? ` of ${bytes(status.total)}` : ''}...`;
  } else if (status?.action === 'installing' || updates?.installing) detail = 'Preparing installation...';
  else if (status?.ready) detail = `Version ${status.available?.version}${status.rollback ? ' (stable rollback)' : status.available?.prerelease ? ' (prerelease)' : ''} is downloaded and ready to install.`;
  else if (status?.available) detail = `Version ${status.available.version}${status.available.prerelease ? ' (prerelease)' : ''} is available.`;
  else if (status?.checkedAt && !updates?.failed) detail = 'No newer release is available for this update channel.';
  else if (status) detail = 'No update check has completed yet.';

  return (
    <>
      <p className="settings-note">Installed version: {status?.currentVersion ?? 'Reading...'}</p>
      <p className="settings-note">Update channel: {includePrereleases ? 'Stable and prerelease' : 'Stable only'}</p>
      <p className="settings-note" role="status">{detail}</p>
      {status?.checkedAt && <p className="settings-note">Last checked {formatRelative(status.checkedAt)}.</p>}
      {status?.action === 'downloading' && (
        <progress
          className="app-update-progress"
          aria-label="Downloading app update"
          max={status.total ?? 1}
          value={status.total ? status.downloaded : undefined}
        />
      )}
      {updates?.failed && <p className="error" role="alert">{updates.failed}</p>}
      <div className="disk-actions app-update-actions">
        {shows('Check for updates') && (
          <button
            type="button"
            className="disk-action"
            disabled={!updates || busy}
            onClick={() => void updates?.check(includePrereleases)}
          >
            Check for updates
          </button>
        )}
        {status?.available && !status.ready && shows('Download update') && (
          <button
            type="button"
            className="disk-action"
            disabled={busy}
            onClick={() => void updates?.download(includePrereleases)}
          >
            Download update
          </button>
        )}
        {shows('Install and restart') && (
          <button
            type="button"
            className="disk-action"
            disabled={!status?.ready || busy || !!installReason}
            title={installReason ?? undefined}
            onClick={() => void updates?.install()}
          >
            Install and restart
          </button>
        )}
        {status?.currentPrerelease && shows('Return to latest stable') && (
          <button
            type="button"
            className="disk-action"
            disabled={busy || dirty || !status.stableVersion}
            title={dirty ? 'Save or discard settings changes first.' : status.stableVersion ? `Return to ${status.stableVersion}` : 'No published stable release is available yet.'}
            onClick={updates?.requestStable}
          >
            Return to latest stable
          </button>
        )}
      </div>
      {status?.ready && (
        <p className="settings-note app-update-ready-note">
          {installReason ?? 'The downloaded update will also install the next time the app starts.'}
        </p>
      )}
      <p className="settings-note">Manual checks download any available update. Installation closes the app.</p>
      {status?.available?.notes && (
        <div className="app-update-notes">
          <button type="button" className="changes-action" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
            Release notes
          </button>
          {notesOpen && <Markdown body={status.available.notes} />}
        </div>
      )}
      {shows('Open logs folder') && (
        <>
          <h4 className="settings-subhead">Debug</h4>
          <div className="disk-actions app-update-debug-actions">
            <button
              type="button"
              className="disk-action"
              onClick={() => {
                setLogsError(null);
                void appLogDir().then(openPath).catch((error: unknown) => {
                  setLogsError(`Could not open logs folder: ${messageOf(error)}`);
                });
              }}
            >
              Open logs folder
            </button>
          </div>
          {logsError && <p className="error" role="alert">{logsError}</p>}
        </>
      )}
    </>
  );
}

export function AppUpdateNotice({ updates }: { updates: AppUpdates }) {
  if (updates.offerRollback) {
    return createPortal(
      <Confirm
        title="Return to the latest stable release?"
        body={`Download stable version ${updates.status?.stableVersion ?? ''} and turn prerelease updates off? This may downgrade the app. It won't restore older copies of your files, and app data changed by a prerelease may be incompatible with this release. Installation still waits for your choice or the next launch, with the usual safety checks.`}
        confirmLabel="Download stable release"
        onConfirm={() => void updates.returnToStable()}
        onCancel={updates.dismissRollback}
      />,
      document.body,
    );
  }
  if (updates.installing) {
    return createPortal(
      <div className="confirm-backdrop">
        <div className="confirm" role="status" aria-live="polite">Preparing the app update...</div>
      </div>,
      document.body,
    );
  }
  if (updates.showNotice && updates.status?.ready && updates.status.available) {
    return createPortal(
      <Confirm
        title="Install app update?"
        body={`Version ${updates.status.available.version} was downloaded. Install it now and restart the app?`}
        confirmLabel="Install and restart"
        cancelLabel="Later"
        onConfirm={() => void updates.install()}
        onCancel={updates.dismiss}
      />,
      document.body,
    );
  }
  if (!updates.installFailed || !updates.status?.available) return null;
  return (
    <div className="app-update-banner" role="status">
      <span>Version {updates.status.available.version} could not be installed.</span>
      <button
        type="button"
        className="changes-action primary"
        disabled={!updates.status.ready || updates.busy || updates.status.action !== 'idle' || !!updates.blocked}
        title={updates.blocked ?? undefined}
        onClick={() => void updates.install()}
      >
        Install and restart
      </button>
      <button type="button" className="changes-action" onClick={updates.dismiss}>Later</button>
      {updates.blocked && <span>{updates.blocked}</span>}
      {updates.installFailed && <span role="alert">{updates.installFailed}</span>}
    </div>
  );
}
