import { useEffect, useMemo, useRef, useState } from 'react';

import { ChevronIcon, CloseIcon, FolderIcon, TickIcon } from './Icons';
import { ModelPicker } from './ModelPicker';
import { LARGEST, SMALLEST, STEP, applyScale, clampScale } from '../lib/scale';
import type { BinnedSession, CliSetting, ModelChoice } from '../../shared/protocol';
import type { CliSettingsState } from '../lib/useCliSettings';
import { DEFAULT_BIN_RETENTION_DAYS } from '../../shared/protocol';
import type { Settings } from '../lib/useSettings';
import { DEFAULT_IDLE_MINUTES, DEFAULT_PERMISSION_MINUTES } from '../lib/useSettings';
import { formatRelative } from '../lib/time';
import { anyMatch, matches, type Searchable } from '../lib/settingsSearch';
import { groupCliSettings, leafName } from '../lib/cliGroups';
import { bytes } from '../lib/units';

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
 * One of the CLI's own settings, drawn from what the CLI says about it.
 *
 * Applied as it is changed rather than on Save, unlike everything else in this window. It
 * belongs to another program's file, and a draft of somebody else's settings held here
 * until Save is a second copy of them that can disagree with the real one.
 *
 * Unset is its own state, kept apart from false and from the empty string: the CLI falls
 * back to its own default, which is not written down anywhere this can read. So a tick box
 * gets three states rather than two, and every control offers a way back to unset.
 */
function CliField({
  setting,
  name,
  value,
  onChange,
}: {
  setting: CliSetting;
  /** What to call it here, which inside a group is the part the heading does not say. */
  name: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const unset = value === undefined;
  /**
   * Whether the control is three buttons rather than one thing to point a label at.
   *
   * A label names its control and activates it, and the browser lights the control up when
   * the label is hovered. Pointed at the first of three that is a lie: the name of the
   * setting is not the name of "on", and the whole row left of the buttons became a way to
   * turn the setting on by accident.
   */
  const grouped = setting.kind === 'boolean';
  const labelId = `cli-label-${setting.path}`;

  return (
    <div className="settings-row">
      {grouped ? (
        <span className="settings-label cli-path" id={labelId}>
          {name}
        </span>
      ) : (
        <label className="settings-label cli-path" htmlFor={`cli-${setting.path}`}>
          {name}
        </label>
      )}

      {setting.kind === 'boolean' && (
        <span className="cli-choice" role="group" aria-labelledby={labelId}>
          {/* Three buttons rather than a tick box, since a tick box cannot say "unset" and
              this app cannot say what the CLI would do instead. */}
          {(['on', 'off', 'default'] as const).map((choice) => {
            const chosen = choice === 'default' ? unset : value === (choice === 'on');
            return (
              <button
                key={choice}
                type="button"
                className={chosen ? 'model-option chosen' : 'model-option'}
                aria-pressed={chosen}
                aria-label={`${setting.path} ${choice}`}
                onClick={() => onChange(choice === 'default' ? null : choice === 'on')}
              >
                {choice}
              </button>
            );
          })}
        </span>
      )}

      {setting.kind === 'enum' && (
        <select
          id={`cli-${setting.path}`}
          className="settings-select"
          value={unset ? '' : String(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">Whatever the CLI does</option>
          {setting.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}

      {(setting.kind === 'string' || setting.kind === 'number') && (
        <input
          id={`cli-${setting.path}`}
          className="settings-text cli-value"
          type={setting.kind === 'number' ? 'number' : 'text'}
          value={unset ? '' : String(value)}
          placeholder="Whatever the CLI does"
          onChange={(event) => {
            const text = event.target.value;
            if (text === '') onChange(null);
            // A number that is not one yet - mid-typing, or a lone minus - is not worth
            // writing to another program's file, so it waits for one that is.
            else if (setting.kind === 'number') {
              const parsed = Number(text);
              if (Number.isFinite(parsed)) onChange(parsed);
            } else onChange(text);
          }}
        />
      )}

      <span className="settings-hint">{setting.description}</span>
    </div>
  );
}

/**
 * A size chosen as a share of something, with steppers rather than a box.
 *
 * Shown as a percentage because that is how a size relative to another size reads, and it
 * moves in the same eighths the keyboard takes rather than letting any number be typed.
 */
function ScaleField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint: string;
}) {
  return (
    <label className="settings-row">
      <span className="settings-label">{label}</span>
      <span className="number-field">
        <input
          type="text"
          readOnly
          className="scale-readout"
          aria-label={label}
          value={`${Math.round(value * 100)}%`}
        />
        <span className="number-steppers">
          <button
            type="button"
            aria-label={`Increase ${label.toLowerCase()}`}
            onClick={() => onChange(clampScale(value + STEP))}
            disabled={value >= LARGEST}
          >
            <ChevronIcon open={false} />
          </button>
          <button
            type="button"
            aria-label={`Decrease ${label.toLowerCase()}`}
            onClick={() => onChange(clampScale(value - STEP))}
            disabled={value <= SMALLEST}
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
  // Last, because it is the only one that is about what is there rather than about what
  // this app should do, and because it is looked at when something has gone wrong.
  { id: 'bin', label: 'Recycle bin' },
] as const satisfies readonly { id: string; label: string }[];

type CategoryId = (typeof CATEGORIES)[number]['id'];

/**
 * What each category holds, for finding a setting without knowing where it lives.
 *
 * Written here rather than worked out from what is drawn, because the sidebar has to know
 * whether a category holds a match before anybody opens it. The labels are the ones the
 * fields carry, and a test walks every category to say so - a name changed in one place
 * and not the other would otherwise leave a setting unfindable, or a category listed as
 * holding something it does not (#204).
 *
 * Keywords are what somebody would search for that the label does not say. The hints under
 * each field are deliberately not searched: they change with what the setting is set to,
 * and a search that found a setting only while it was off would be worse than one that
 * never found it.
 */
const INDEX: Record<CategoryId, Searchable[]> = {
  management: [
    { label: 'Sessions kept in memory', keywords: 'limit cap resident loaded ram' },
    { label: 'Release an idle session after', keywords: 'timeout minutes evict unload memory' },
    { label: 'Answer a question for me after', keywords: 'permission timeout wait give up prompt' },
    { label: 'Ask before deleting a session', keywords: 'confirm delete warn' },
  ],
  sessions: [
    { label: 'Run tools without asking', keywords: 'allow all yolo permission approve' },
    { label: 'Model', keywords: 'effort reasoning context window default' },
    { label: 'Working directory', keywords: 'folder path cwd start' },
  ],
  appearance: [
    { label: 'App scale', keywords: 'size zoom bigger smaller' },
    { label: 'Text size', keywords: 'font scale reading transcript' },
  ],
  cli: [{ label: 'Update the CLI when the app starts', keywords: 'upgrade version auto' }],
  bin: [
    { label: 'Keep a deleted session for', keywords: 'retention days recycle bin restore' },
    { label: 'Waiting to be deleted', keywords: 'recycle bin restore purge deleted sessions' },
  ],
};

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
  models,
  onNeedModels,
  binned,
  onNeedBin,
  onRestore,
  onPurge,
  cli,
  onNeedCli,
  onWriteCli,
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
  /**
   * The models to choose a default from, or nothing when none have been read.
   *
   * Handed in rather than asked for here: the catalogue belongs to the app, which keeps
   * one between runs precisely because reading it costs a server process.
   */
  models?: ModelChoice[] | null;
  /**
   * Ask for the catalogue, when there is none to show.
   *
   * Called on reaching the category that needs it rather than on opening the window, and
   * only when nothing is known: somebody changing the text size should not start a Copilot
   * process, and somebody choosing a model cannot do it from an empty list (#200).
   */
  onNeedModels?: () => void;
  /**
   * What is waiting in the recycle bin, or null while that is still being read.
   *
   * Handed in for the same reason the models are: this window is drawn in tests, and one
   * that reached for the sidecar itself could not be.
   */
  binned?: BinnedSession[] | null;
  /** Ask what is in the bin. Called on reaching the category rather than on opening. */
  onNeedBin?: () => void;
  onRestore?: (sessionId: string) => void;
  onPurge?: (sessionId: string) => void;
  /**
   * The CLI's own settings, or null while they are being read.
   *
   * An empty list is a real answer rather than a failure: it is what a CLI this app cannot
   * read gives, and the window says so rather than showing an empty category.
   */
  cli?: CliSettingsState | null;
  /** Ask for them. Called on reaching the category, since reading costs a 90MB file. */
  onNeedCli?: () => void;
  /**
   * Write some of them, straight away rather than on Save.
   *
   * They belong to another program's file, and holding a draft of somebody else's settings
   * until Save is a second copy of them that can disagree with the real one.
   */
  onWriteCli?: (changes: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [category, setCategory] = useState<CategoryId>(CATEGORIES[0].id);
  const [pending, setPending] = useState<Pending | null>(null);
  const [query, setQuery] = useState('');
  /**
   * Which nested groups of CLI settings are open. Closed to begin with, which is the point
   * of gathering them: the category opens as a list of subjects rather than a wall of rows.
   */
  const [opened, setOpened] = useState<string[]>([]);

  /**
   * What each category holds, with the CLI's own settings folded into theirs.
   *
   * Theirs are data already, so they carry their own description and their own options -
   * which is how searching `prerelease` finds the update channel without knowing its name.
   */
  const searchable: Record<CategoryId, Searchable[]> = useMemo(
    () => ({
      ...INDEX,
      cli: [
        ...INDEX.cli,
        ...(cli?.settings ?? []).map((setting) => ({
          label: setting.path,
          keywords: setting.description,
          options: setting.options,
        })),
      ],
    }),
    [cli],
  );

  /** Only the categories holding something worth opening them for. */
  const listed = CATEGORIES.filter((entry) => anyMatch(query, searchable[entry.id]));

  /** Whether a setting in the category being looked at answers what was typed. */
  const shows = (label: string) => {
    const entry = searchable[category].find((known) => known.label === label);
    return matches(query, entry ?? { label });
  };

  /** The CLI's settings with the nested ones gathered under what they are nested in. */
  const cliEntries = useMemo(() => groupCliSettings(cli?.settings ?? []), [cli]);

  /**
   * Whether a group is showing what is inside it.
   *
   * A search opens every group it left standing. The reader has already said what they are
   * looking for, and answering with a closed heading they have to open is asking twice.
   */
  const isOpen = (prefix: string) => query.trim() !== '' || opened.includes(prefix);

  const toggleGroup = (prefix: string) =>
    setOpened((current) =>
      current.includes(prefix) ? current.filter((name) => name !== prefix) : [...current, prefix],
    );

  const unsaved = (Object.keys(draft) as (keyof Settings)[]).some((key) => draft[key] !== settings[key]);

  /**
   * How many sessions in the bin the draft retention would delete.
   *
   * Worked out here rather than asked of the runtime, which would mean a round trip per
   * keystroke on a number field. The same rule the sweep uses, counted from when each was
   * binned, so the two agree about what is past it.
   */
  const losing =
    binned?.filter(
      (session) => Date.now() - Date.parse(session.binnedAt) >= draft.binRetentionDays * 24 * 60 * 60 * 1000,
    ).length ?? 0;

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

  /**
   * Fetch the catalogue on reaching the category that needs it, if there is none.
   *
   * Not on opening the window: reading it costs a server process, and somebody changing
   * the text size has not asked for one. Once, because a failure is remembered by the
   * caller and asking again on every render would spend the same process repeatedly.
   */
  const askedForModels = useRef(false);
  useEffect(() => {
    if (category !== 'sessions' || askedForModels.current) return;
    if (models && models.length > 0) return;

    askedForModels.current = true;
    onNeedModels?.();
  }, [category, models, onNeedModels]);

  /**
   * Read the bin on reaching it, and again every time it is reached.
   *
   * Unlike the catalogue this is not cached anywhere and costs only a directory listing, so
   * asking again is how the list is right after something is restored or deleted rather
   * than showing what was there when the window opened.
   *
   * Reading it is also what applies the retention, so a saved change to how long a session
   * is kept takes effect on what is already there - and is seen taking effect, rather than
   * leaving rows on screen that have already gone.
   */
  useEffect(() => {
    if (category === 'bin') onNeedBin?.();
  }, [category, onNeedBin, settings.binRetentionDays]);

  /**
   * Read the CLI's own settings once, as the window opens.
   *
   * On opening rather than on reaching the category, even though nobody changing the text
   * size needs them: the category is long enough to scroll, and arriving a moment after it
   * is looked at meant it was drawn short and then grew under the reader.
   *
   * The cost is a 90MB read in the sidecar, which is 60ms somewhere that is not this
   * window, against a category that visibly assembles itself. Once, since nothing this
   * window does changes what the CLI knows about.
   */
  const askedForCli = useRef(false);
  useEffect(() => {
    if (askedForCli.current || cli) return;

    askedForCli.current = true;
    onNeedCli?.();
  }, [cli, onNeedCli]);

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
    applyScale(draft.scale, draft.textScale);
    return () => applyScale(settings.scale, settings.textScale);
  }, [draft.scale, draft.textScale, settings.scale, settings.textScale]);

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

          {/* Filters the list below it and what is drawn beside it, by the same rule: a
              category listed as holding a match and opened to nothing would be worse than
              one that was never listed. */}
          <input
            type="search"
            className="settings-search"
            aria-label="Search settings"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {listed.map((entry) => (
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

          {listed.length === 0 && <p className="settings-note">Nothing matches.</p>}
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

                {shows('Sessions kept in memory') && (
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
                )}

                {shows('Release an idle session after') && (
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
                )}

                <h4 className="settings-subhead">Waiting for you</h4>

                {shows('Answer a question for me after') && (
                  <NumberField
                    label="Answer a question for me after"
                    value={draft.permissionMinutes}
                    onChange={(value) => edit('permissionMinutes', value)}
                    hint={
                      draft.permissionMinutes === 0
                        ? 'Never. A question stands until it is answered, and the turn waits however long that takes.'
                        : `${draft.permissionMinutes} ${draft.permissionMinutes === 1 ? 'minute' : 'minutes'}, after which the turn carries on without whatever was asked for. The default is ${DEFAULT_PERMISSION_MINUTES}.`
                    }
                  />
                )}

                <h4 className="settings-subhead">Deleting</h4>

                {shows('Ask before deleting a session') && (
                  <TickField
                    label="Ask before deleting a session"
                    checked={draft.confirmDelete}
                    onChange={(checked) => edit('confirmDelete', checked)}
                    hint={
                      draft.binRetentionDays > 0
                        ? 'Deleting takes the transcript and everything the session wrote out of the list. The recycle bin keeps it for a while.'
                        : 'Deleting removes the transcript and everything the session wrote. There is no undo.'
                    }
                  />
                )}
              </>
            )}

            {shown.id === 'sessions' && (
              <>
                <p className="settings-note">
                  What a session starts with when it is made from the New button.
                </p>

                {shows('Run tools without asking') && (
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
                )}

                <div className="settings-row">
                  <span className="settings-label">Model</span>
                  {/* The picker a session uses, rather than one of its own: how hard it
                      thinks and how much room it has are part of the choice, and a second
                      control would be a second set of rules to keep in step (#200). */}
                  <ModelPicker
                    current={
                      draft.defaultModel
                        ? {
                            model: draft.defaultModel,
                            reasoningEffort: draft.defaultEffort || undefined,
                            contextTier: draft.defaultContext || undefined,
                          }
                        : null
                    }
                    models={models ?? null}
                    // No session, so no window to be full: the sizes still describe what a
                    // model would have, which is what is being chosen here.
                    usage={null}
                    failed={null}
                    onOpen={() => onNeedModels?.()}
                    onChoose={(choice) =>
                      setDraft((current) => ({
                        ...current,
                        defaultModel: choice.model,
                        defaultEffort: choice.reasoningEffort ?? '',
                        defaultContext: choice.contextTier ?? '',
                      }))
                    }
                    emptyLabel="Whatever the runtime picks"
                  />
                  <span className="settings-hint">
                    {draft.defaultModel
                      ? 'Set when the session is made, and still changeable per session afterwards.'
                      : 'The runtime chooses, which is auto. Naming one also saves the titling a detour, since auto cannot answer the question a title comes from.'}
                  </span>
                  {draft.defaultModel && (
                    <button
                      type="button"
                      className="settings-reset"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          defaultModel: '',
                          defaultEffort: '',
                          defaultContext: '',
                        }))
                      }
                    >
                      Let the runtime choose again
                    </button>
                  )}
                </div>
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
                  Two scales, each keeping its own proportions. The app scale moves everything; the text
                  size moves only the letters, on top of it.
                </p>

                {shows('App scale') && (
                  <ScaleField
                    label="App scale"
                    value={draft.scale}
                    onChange={(value) => edit('scale', value)}
                    hint={
                      draft.scale === 1
                        ? 'Everything: the panes, the lanes and the controls as well as the letters. Ctrl and + or - does the same, as does Ctrl and the wheel.'
                        : `${Math.round(draft.scale * 100)}% of the app's own size. Ctrl and + or - does the same.`
                    }
                  />
                )}

                {shows('Text size') && (
                  <ScaleField
                    label="Text size"
                    value={draft.textScale}
                    onChange={(value) => edit('textScale', value)}
                    hint={
                      draft.textScale === 1
                        ? 'The letters alone, if they read small at a scale that otherwise suits.'
                        : `${Math.round(draft.textScale * 100)}% of the size the app scale would give them.`
                    }
                  />
                )}

                {(draft.scale !== 1 || draft.textScale !== 1) && (
                  <button
                    type="button"
                    className="settings-reset"
                    onClick={() => setDraft((current) => ({ ...current, scale: 1, textScale: 1 }))}
                  >
                    Back to the app&apos;s own sizes
                  </button>
                )}
              </>
            )}
            {shown.id === 'cli' && (
              <>
                {shows('Update the CLI when the app starts') && (
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

                <h4 className="settings-subhead">The CLI's own settings</h4>
                {/* Written straight to the CLI's file rather than kept here, so a setting
                    means the same thing in both places. They apply without restarting
                    anything: the CLI reads them when a session is made (#202). */}
                <p className="settings-note">
                  Kept by the CLI itself, in its own settings file, and shared with it. A change here
                  reaches the next session either program starts.
                </p>

                {cli === null && <p className="settings-note">Reading what the CLI knows about.</p>}
                {cli?.settings.length === 0 && (
                  <p className="settings-note">
                    This CLI could not be read, so there is nothing to show. Its settings are still
                    changeable from the CLI itself.
                  </p>
                )}

                {cliEntries.map((entry) => {
                  if (entry.kind === 'one') {
                    return shows(entry.setting.path) ? (
                      <CliField
                        key={entry.setting.path}
                        setting={entry.setting}
                        name={entry.setting.path}
                        value={cli?.values[entry.setting.path]}
                        onChange={(value) => onWriteCli?.({ [entry.setting.path]: value })}
                      />
                    ) : null;
                  }

                  const { prefix, settings: inside } = entry.group;
                  const matching = inside.filter((setting) => shows(setting.path));
                  // A group whose every setting was filtered out is a heading over nothing.
                  if (matching.length === 0) return null;

                  const open = isOpen(prefix);
                  return (
                    <div className="cli-group" key={prefix}>
                      <button
                        type="button"
                        className="cli-group-head"
                        aria-expanded={open}
                        aria-label={`${prefix}, ${matching.length} settings`}
                        onClick={() => toggleGroup(prefix)}
                      >
                        {prefix}
                        <span className="cli-group-count">{matching.length}</span>
                        <ChevronIcon open={open} />
                      </button>

                      {open &&
                        matching.map((setting) => (
                          <CliField
                            key={setting.path}
                            setting={setting}
                            name={leafName(setting.path, prefix)}
                            value={cli?.values[setting.path]}
                            onChange={(value) => onWriteCli?.({ [setting.path]: value })}
                          />
                        ))}
                    </div>
                  );
                })}
              </>
            )}

            {shown.id === 'bin' && (
              <>
                <p className="settings-note">
                  Deleted sessions wait here before they are really deleted. Restoring one puts it back
                  exactly where it was, with its title and its place in the list.
                </p>

                {shows('Keep a deleted session for') && (
                  <NumberField
                    label="Keep a deleted session for"
                    value={draft.binRetentionDays}
                    onChange={(value) => edit('binRetentionDays', value)}
                    hint={
                      draft.binRetentionDays === 0
                        ? 'Deleting is immediate and cannot be undone.'
                        : `${draft.binRetentionDays} ${draft.binRetentionDays === 1 ? 'day' : 'days'}, counted from when it was deleted. The default is ${DEFAULT_BIN_RETENTION_DAYS}.`
                    }
                  />
                )}

                {/* Saving applies the new rule to what is already here, so anything past it
                    goes at that point. Said before it is saved rather than discovered after:
                    the rows are listed directly below, and they are all there is left of
                    those sessions. */}
                {losing > 0 && (
                  <p className="settings-warning">
                    Saving will delete {losing === 1 ? 'the session' : `${losing} of the sessions`} below, which
                    {losing === 1 ? ' has' : ' have'} been here longer than{' '}
                    {draft.binRetentionDays === 0 ? 'the new setting keeps anything' : 'the new setting allows'}.
                  </p>
                )}

                <h4 className="settings-subhead">Waiting to be deleted</h4>

                {binned === null && <p className="settings-note">Reading the bin.</p>}
                {binned?.length === 0 && <p className="settings-note">Nothing has been deleted.</p>}

                {binned?.map((session) => (
                  <div className="settings-row bin-row" key={session.sessionId}>
                    <span className="bin-what">
                      <span className="bin-title">{session.title ?? 'Untitled session'}</span>
                      <span className="settings-hint">
                        Deleted {formatRelative(session.binnedAt)} · {bytes(session.bytes)}
                      </span>
                    </span>
                    <span className="bin-actions">
                      <button type="button" className="settings-reset" onClick={() => onRestore?.(session.sessionId)}>
                        Restore
                      </button>
                      <button
                        type="button"
                        className="settings-reset destructive"
                        onClick={() => onPurge?.(session.sessionId)}
                      >
                        Delete now
                      </button>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="confirm-actions">
            {/* Three buttons, each doing one thing, because keeping a change and carrying on
                looking, keeping it and leaving, and leaving without it are three different
                intentions and one Save that also closed could only serve one of them.

                Cancel closes without saving, which puts the draft back by throwing it away
                with the window - including the scale, which is put back as this unmounts. */}
            <button type="button" className="confirm-cancel" onClick={onClose} disabled={!unsaved}>
              Cancel
            </button>
            <button type="button" className="confirm-cancel" onClick={() => onSave(draft)} disabled={!unsaved}>
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                if (unsaved) onSave(draft);
                onClose();
              }}
            >
              Done
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
