import { useEffect, useState } from 'react';

import { ChevronIcon, TickIcon } from './Icons';
import type { Settings } from '../lib/useSettings';
import { DEFAULT_IDLE_MINUTES } from '../lib/useSettings';

/**
 * A whole number, with its own steppers.
 *
 * The native ones are not drawn by this app and did not follow it: they came out as a pale
 * strip at the edge of a dark field, and `color-scheme: dark` does not reach them here. So
 * they are hidden and replaced, which is what the icons in this app already do rather than
 * relying on a glyph rendering the same everywhere.
 *
 * Typing still works, and so do the arrow keys, which a number field answers on its own.
 */
function NumberField({
  label,
  value,
  onChange,
  min = 0,
  hint,
}: {
  /** Names the field and both of its steppers, so each says what it changes. */
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  hint: string;
}) {
  // No floor here: the control that would go below the minimum is disabled at it, so a
  // second guard would be a line nothing can reach. What is typed is floored on its way in.
  const step = (by: number) => onChange(value + by);

  return (
    <label className="settings-row">
      <span className="settings-label">{label}</span>
      <span className="number-field">
        <input
          type="number"
          min={min}
          step={1}
          aria-label={label}
          value={value}
          onChange={(event) => onChange(Math.max(min, Math.floor(Number(event.target.value) || 0)))}
        />
        <span className="number-steppers">
          <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => step(1)}>
            <ChevronIcon open={false} />
          </button>
          <button
            type="button"
            aria-label={`Fewer ${label.toLowerCase()}`}
            onClick={() => step(-1)}
            disabled={value <= min}
          >
            <ChevronIcon open={false} />
          </button>
        </span>
      </span>
      <span className="settings-hint">{hint}</span>
    </label>
  );
}

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

          <NumberField
            label="Sessions kept in memory"
            value={draft.maxLoaded}
            onChange={(value) => edit('maxLoaded', value)}
            hint={
              draft.maxLoaded === 0
                ? 'No limit. The least recently used is released only when it has been idle.'
                : `Past ${draft.maxLoaded}, the least recently used is released. One mid-turn is never released.`
            }
          />

          <NumberField
            label="Release an idle session after"
            value={draft.idleMinutes}
            onChange={(value) => edit('idleMinutes', value)}
            hint={
              draft.idleMinutes === 0
                ? 'Never. Sessions stay in memory until the app closes or the limit above releases them.'
                : `${draft.idleMinutes} ${draft.idleMinutes === 1 ? 'minute' : 'minutes'}. The default is ${DEFAULT_IDLE_MINUTES}.`
            }
          />
        </section>

        <section className="settings-group">
          <h3>Deleting</h3>

          <div className="settings-row settings-check">
            {/* The label wraps the box and its own text and stops there. Taking the note
                in as well made a sentence explaining the setting into another way to
                change it, which is easy to do by accident while reading. */}
            <label className="tick-row">
              {/* The tick is drawn beside the box rather than in it: a pseudo-element on
                  an input is not something every engine renders, and this one is ours
                  either way. The input keeps the name, the focus and the hit area. */}
              <span className="tickbox">
                <input
                  type="checkbox"
                  aria-label="Ask before deleting a session"
                  checked={draft.confirmDelete}
                  onChange={(event) => edit('confirmDelete', event.target.checked)}
                />
                <TickIcon />
              </span>
              <span className="settings-label">Ask before deleting a session</span>
            </label>
            <span className="settings-hint">Deleting removes the transcript and everything the session wrote.</span>
          </div>
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
