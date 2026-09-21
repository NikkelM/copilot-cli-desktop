import { useEffect, useState } from 'react';

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
 * Nothing takes effect until it is saved. Half-typed numbers are why: a field being cleared
 * to type 25 into passes through empty, and applying as it was typed would have released
 * every session in memory on the way past. Leaving without saving changes nothing, which is
 * what makes it safe to open this and look.
 */
export function SettingsWindow({
  settings,
  onSave,
  onClose,
}: {
  /** What is saved now, which is where the draft starts and what leaving goes back to. */
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Settings>(settings);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // Escape is leaving without saving, which is what Cancel does: a reader who wanted
      // these kept would have said so, and the alternative is a dialog about a dialog.
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const edit = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const unsaved = (Object.keys(draft) as (keyof Settings)[]).some((key) => draft[key] !== settings[key]);

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
              value={draft.maxLoaded}
              onChange={(event) => edit('maxLoaded', Math.max(0, Math.floor(Number(event.target.value) || 0)))}
            />
            <span className="settings-hint">
              {draft.maxLoaded === 0
                ? 'No limit. The least recently used is released only when it has been idle.'
                : `Past ${draft.maxLoaded}, the least recently used is released. One mid-turn is never released.`}
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Release an idle session after</span>
            <input
              type="number"
              min={0}
              step={1}
              aria-label="Release an idle session after"
              value={draft.idleMinutes}
              onChange={(event) => edit('idleMinutes', Math.max(0, Math.floor(Number(event.target.value) || 0)))}
            />
            <span className="settings-hint">
              {draft.idleMinutes === 0
                ? 'Never. Sessions stay in memory until the app closes or the limit above releases them.'
                : `${draft.idleMinutes} ${draft.idleMinutes === 1 ? 'minute' : 'minutes'}. The default is ${DEFAULT_IDLE_MINUTES}.`}
            </span>
          </label>
        </section>

        <section className="settings-group">
          <h3>Deleting</h3>

          <label className="settings-row settings-check">
            <input
              type="checkbox"
              aria-label="Ask before deleting a session"
              checked={draft.confirmDelete}
              onChange={(event) => edit('confirmDelete', event.target.checked)}
            />
            <span className="settings-label">Ask before deleting a session</span>
            <span className="settings-hint">Deleting removes the transcript and everything the session wrote.</span>
          </label>
        </section>

        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
            // Nothing changed is not nothing to do: the window still has to close, so this
            // says Done rather than offering a Save that would save nothing.
          >
            {unsaved ? 'Save' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}
