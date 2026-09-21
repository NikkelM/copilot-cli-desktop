import { useEffect } from 'react';

import type { Settings } from '../lib/useSettings';
import { DEFAULT_IDLE_MINUTES } from '../lib/useSettings';

/**
 * A place to change the choices this app would otherwise make for you (#100).
 *
 * Two of these are the memory story the app is built on, and were fixed in code: how many
 * sessions may stay resumed, and how long an untouched one is kept. What is right depends
 * on how much memory a machine has to spare, which is not something this app can know.
 *
 * The third is here because it was a one-way door. Ticking "do not ask again" on a delete
 * turned the confirmation off with no way back except editing a file by hand, which is a
 * poor way to treat the one action in the app that destroys something.
 *
 * Changes apply as they are made rather than on an OK button: there is nothing here that is
 * only half meaningful, and a window that asks to be confirmed invites being cancelled.
 */
export function SettingsWindow({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-title">Settings</h2>

        <section className="settings-group">
          <h3>Memory</h3>
          <p className="settings-note">
            A session costs nothing until it is opened. These decide how much is kept once it has been.
          </p>

          <label className="settings-row">
            <span className="settings-label">Sessions kept in memory</span>
            <input
              type="number"
              min={0}
              step={1}
              aria-label="Sessions kept in memory"
              value={settings.maxLoaded}
              onChange={(event) => onChange('maxLoaded', Math.max(0, Math.floor(Number(event.target.value) || 0)))}
            />
            <span className="settings-hint">
              {settings.maxLoaded === 0
                ? 'No limit. The least recently used is released only when it has been idle.'
                : `Past ${settings.maxLoaded}, the least recently used is released. One mid-turn is never released.`}
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Release an idle session after</span>
            <input
              type="number"
              min={0}
              step={1}
              aria-label="Release an idle session after"
              value={settings.idleMinutes}
              onChange={(event) => onChange('idleMinutes', Math.max(0, Math.floor(Number(event.target.value) || 0)))}
            />
            <span className="settings-hint">
              {settings.idleMinutes === 0
                ? 'Never. Sessions stay in memory until the app closes or the limit above releases them.'
                : `${settings.idleMinutes} ${settings.idleMinutes === 1 ? 'minute' : 'minutes'}. The default is ${DEFAULT_IDLE_MINUTES}.`}
            </span>
          </label>
        </section>

        <section className="settings-group">
          <h3>Deleting</h3>

          <label className="settings-row settings-check">
            <input
              type="checkbox"
              aria-label="Ask before deleting a session"
              checked={settings.confirmDelete}
              onChange={(event) => onChange('confirmDelete', event.target.checked)}
            />
            <span className="settings-label">Ask before deleting a session</span>
            <span className="settings-hint">Deleting removes the transcript and everything the session wrote.</span>
          </label>
        </section>

        <div className="confirm-actions">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
