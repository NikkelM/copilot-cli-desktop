import { useEffect, useState } from 'react';

import { ChevronIcon, CloseIcon, FolderIcon, TickIcon } from './Icons';
import { LARGEST, SMALLEST, STEP, applyScale, clampScale } from '../lib/scale';
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

/** A setting that is on or off, with its note beside it rather than inside its label. */
function TickField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint: string;
}) {
  return (
    <div className="settings-row settings-check">
      {/* The label wraps the box and its own text and stops there. Taking the note in as
          well made a sentence explaining the setting into another way to change it, which
          is easy to do by accident while reading. */}
      <label className="tick-row">
        {/* The tick is drawn beside the box rather than in it: a pseudo-element on an input
            is not something every engine renders, and this one is ours either way. The
            input keeps the name, the focus and the hit area. */}
        <span className="tickbox">
          <input
            type="checkbox"
            aria-label={label}
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
          />
          <TickIcon />
        </span>
        <span className="settings-label">{label}</span>
      </label>
      <span className="settings-hint">{hint}</span>
    </div>
  );
}

/**
 * The groups the settings are divided into.
 *
 * Which settings belong to each is not recorded here, because nothing needs it: what stops
 * a category being left is whether the draft differs from what is saved at all, and a
 * setting in another category cannot have been changed without going there first - which
 * is the thing being stopped (#100).
 */
const CATEGORIES = [
  { id: 'management', label: 'Session management' },
  { id: 'sessions', label: 'New sessions' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'cli', label: 'Copilot CLI' },
] as const satisfies readonly { id: string; label: string }[];

type CategoryId = (typeof CATEGORIES)[number]['id'];

/** What a reader was trying to do when they were stopped by unsaved changes. */
type Pending = { go: 'close' } | { go: 'category'; to: CategoryId };

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
 * every session in memory on the way past.
 *
 * Leaving with something changed is stopped and asked about, wherever the leaving was
 * headed - another category, the corner, the keyboard, or the page behind. Cancel is the
 * exception, because discarding is what it is for and asking would be asking twice.
 *
 * Saving does not close. The two are separate decisions, and a window that shut itself on
 * saving left no way to keep a change and carry on looking at the rest.
 */
export function SettingsWindow({
  settings,
  onSave,
  onClose,
  onPickDirectory,
}: {
  /** What is saved now, which is where the draft starts and what discarding goes back to. */
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
  /**
   * Ask for a folder, starting at the one given, and answer with what was chosen.
   *
   * Passed in rather than opened here: the picker is native, and a window that reached
   * for it directly could not be drawn in a test.
   */
  onPickDirectory?: (startingAt: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [category, setCategory] = useState<CategoryId>(CATEGORIES[0].id);
  const [pending, setPending] = useState<Pending | null>(null);

  const unsaved = (Object.keys(draft) as (keyof Settings)[]).some((key) => draft[key] !== settings[key]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A question about leaving is answered before it can be left, or Escape would close
      // the window out from under the question it raised.
      if (pending) setPending(null);
      else leave({ go: 'close' });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
    // Rebound on every render rather than held: what this does depends on the draft and on
    // whether a question is open, and a listener registered once would answer with
    // whichever of those was true when the window opened.
  });

  const edit = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /**
   * Draw at the size being chosen, before it is saved.
   *
   * A size is picked by looking at the result, so this is the one setting here that has to
   * take effect while it is still a draft. Put back on the way out, which covers cancelling
   * and closing; saving makes the two the same, so putting it back changes nothing (#139).
   */
  useEffect(() => {
    applyScale(draft.scale);
    return () => applyScale(settings.scale);
  }, [draft.scale, settings.scale]);

  /** Go, or ask first if there is something that would be lost by going. */
  const leave = (to: Pending) => {
    if (unsaved) {
      setPending(to);
      return;
    }
    if (to.go === 'close') onClose();
    else setCategory(to.to);
  };

  /** Carry on with what was interrupted, once the question has been answered. */
  const resume = (answer: 'save' | 'discard') => {
    if (answer === 'save') onSave(draft);
    else setDraft(settings);

    if (pending?.go === 'close') onClose();
    else if (pending) setCategory(pending.to);
    setPending(null);
  };

  const shown = CATEGORIES.find((entry) => entry.id === category) ?? CATEGORIES[0];

  return (
    <div className="confirm-backdrop" onMouseDown={() => leave({ go: 'close' })}>
      <div
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav className="settings-nav" aria-label="Settings categories">
          <h2 className="settings-title">Settings</h2>
          {CATEGORIES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === category ? 'settings-tab current' : 'settings-tab'}
              aria-current={entry.id === category}
              onClick={() => leave({ go: 'category', to: entry.id })}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="settings-main">
          <header className="settings-head">
            <h3>{shown.label}</h3>
            <button type="button" className="icon-button" aria-label="Close settings" onClick={() => leave({ go: 'close' })}>
              <CloseIcon />
            </button>
          </header>

          <div className="settings-body">
            {shown.id === 'management' && (
              <>
                <h4 className="settings-subhead">Memory</h4>
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

                <h4 className="settings-subhead">Deleting</h4>

                <TickField
                  label="Ask before deleting a session"
                  checked={draft.confirmDelete}
                  onChange={(checked) => edit('confirmDelete', checked)}
                  hint="Deleting removes the transcript and everything the session wrote."
                />
              </>
            )}

            {shown.id === 'sessions' && (
              <>
                <p className="settings-note">
                  What a session starts with when it is made from the New button.
                </p>

                <TickField
                  label="Run tools without asking"
                  checked={draft.allowAll}
                  onChange={(checked) => edit('allowAll', checked)}
                  hint={
                    draft.allowAll
                      ? 'The same as the CLI --allow-all and --yolo, which are the same flag. Set on the session once it is made, and it can still be changed per session afterwards.'
                      : 'Each tool asks before it runs, which is what the CLI does by default.'
                  }
                />

                <label className="settings-row">
                  <span className="settings-label">Working directory</span>
                  <span className="path-field">
                    <input
                      type="text"
                      className="settings-text"
                      aria-label="Working directory"
                      placeholder="Your home directory"
                      spellCheck={false}
                      value={draft.workingDirectory}
                      onChange={(event) => edit('workingDirectory', event.target.value)}
                    />
                    {/* Typed or pasted either way. The picker is for choosing one, and
                        starts where the setting already points so it opens near the last
                        answer rather than at the top of the disk (#173). */}
                    {onPickDirectory && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Choose a working directory"
                        title="Choose a folder"
                        onClick={() => {
                          void onPickDirectory(draft.workingDirectory).then((picked) => {
                            if (picked) edit('workingDirectory', picked);
                          });
                        }}
                      >
                        <FolderIcon />
                      </button>
                    )}
                  </span>
                  <span className="settings-hint">
                    Where a new session starts. Left empty it is your home directory, which is what the CLI
                    does when it is run with no directory.
                  </span>
                </label>
              </>
            )}

            {shown.id === 'appearance' && (
              <>
                <p className="settings-note">
                  One scale rather than a size for each thing. The sizes are in proportion to each other on
                  purpose, and setting them apart would only let that be broken.
                </p>

                <label className="settings-row">
                  <span className="settings-label">Text size</span>
                  <span className="number-field">
                    <input
                      type="text"
                      readOnly
                      className="scale-readout"
                      aria-label="Text size"
                      value={`${Math.round(draft.scale * 100)}%`}
                    />
                    <span className="number-steppers">
                      <button
                        type="button"
                        aria-label="Larger text"
                        onClick={() => edit('scale', clampScale(draft.scale + STEP))}
                        disabled={draft.scale >= LARGEST}
                      >
                        <ChevronIcon open={false} />
                      </button>
                      <button
                        type="button"
                        aria-label="Smaller text"
                        onClick={() => edit('scale', clampScale(draft.scale - STEP))}
                        disabled={draft.scale <= SMALLEST}
                      >
                        <ChevronIcon open={false} />
                      </button>
                    </span>
                  </span>
                  <span className="settings-hint">
                    {draft.scale === 1
                      ? 'The size the app is drawn at. Ctrl and + or - does the same, as does Ctrl and the wheel.'
                      : `${Math.round(draft.scale * 100)}% of the app's own size. Ctrl and + or - does the same.`}
                  </span>
                </label>

                {draft.scale !== 1 && (
                  <button type="button" className="settings-reset" onClick={() => edit('scale', 1)}>
                    Back to the app&apos;s own size
                  </button>
                )}
              </>
            )}

            {shown.id === 'cli' && (
              <TickField
                label="Update the CLI when the app starts"
                checked={draft.updateOnStart}
                onChange={(checked) => edit('updateOnStart', checked)}
                hint={
                  draft.updateOnStart
                    ? 'Runs copilot update as the app starts. It carries on without waiting, so a slow download does not hold the app up.'
                    : 'The CLI updates itself on startup, but never when this app launches it, so it stays on the version it has.'
                }
              />
            )}
          </div>

          <div className="confirm-actions">
            {/* Two buttons, each doing one thing. Saving used to close as well, which meant
                there was no way to keep a change and carry on looking. */}
            <button type="button" className="confirm-cancel" onClick={onClose}>
              {unsaved ? 'Cancel' : 'Close'}
            </button>
            <button type="button" onClick={() => onSave(draft)} disabled={!unsaved}>
              Save
            </button>
          </div>
        </div>

        {pending && (
          <div className="settings-pending" role="alertdialog" aria-modal="true" aria-label="Unsaved changes">
            <p>
              {pending.go === 'close'
                ? 'This window has changes that have not been saved.'
                : `${shown.label} has changes that have not been saved.`}
            </p>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={() => setPending(null)}>
                Keep editing
              </button>
              <button type="button" className="confirm-cancel" onClick={() => resume('discard')}>
                Discard
              </button>
              <button type="button" onClick={() => resume('save')}>
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
