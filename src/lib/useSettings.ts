import { useCallback, useEffect, useRef, useState } from 'react';

import { read, save } from './store';
import { setRuntimeLimits, updateCli } from './sidecar';
import { DEFAULT_BIN_RETENTION_DAYS, DEFAULT_PERMISSION_TIMEOUT_MS } from '../../shared/protocol';
import { SCALE_KEY, TEXT_SCALE_KEY, applyScale, readScale, readTextScale } from './scale';

/**
 * The choices this app makes that somebody might reasonably make differently.
 *
 * Kept here rather than spread through the hooks that use them, because a settings window
 * needs one place to read and write - and because two of them are not the app's to keep
 * alone: the memory rules belong to the runtime, which has to be told when they change
 * (#100).
 *
 * Text size and sidebar width are deliberately not here. They are changed by gesture, where
 * the effect is visible while you do it, and a number in a window is a worse way to pick a
 * size than making it bigger until it looks right.
 */

/** How many sessions the runtime keeps resumed. Zero is the default, meaning no cap. */
export const MAX_LOADED = 'maxLoadedSessions';
/** Minutes a resumed session may sit untouched before it is released. Zero never releases. */
export const IDLE_MINUTES = 'idleMinutes';
/** Whether deleting a session asks first. */
export const CONFIRM_DELETE = 'confirmDelete';
/** Minutes a question to the reader waits before answering itself. Zero never gives up. */
export const PERMISSION_MINUTES = 'permissionMinutes';
/** How many days a deleted session waits in the bin. Zero deletes it outright. */
export const BIN_RETENTION_DAYS = 'binRetentionDays';
/** Whether a session this app starts asks before running tools. */
export const ALLOW_ALL = 'allowAll';
/** Where a session starts when none was chosen. Empty means the home directory. */
export const WORKING_DIRECTORY = 'workingDirectory';
/** Which model a new session starts on. Empty means whatever the runtime picks. */
export const DEFAULT_MODEL = 'defaultModel';

/** How hard it should think, and how much room it should have. Empty means the model's own. */
export const DEFAULT_EFFORT = 'defaultEffort';
export const DEFAULT_CONTEXT = 'defaultContext';

/** Whether to bring the Copilot CLI up to date when the app starts. */
export const UPDATE_ON_START = 'updateOnStart';

export interface Settings {
  /** Zero means no cap, which is what the runtime starts with. */
  maxLoaded: number;
  /** Zero means never, which is a real choice on a machine with memory to spare. */
  idleMinutes: number;
  /**
   * How long the agent waits for an answer before it answers for you.
   *
   * One number for all four kinds of question - a permission, a question, a prompt for
   * input, a plan - because they are one thing from here: how long it waits. Each lapses
   * to the "no" of its own kind.
   *
   * Zero never gives up, which is what somebody who would rather come back to a question
   * than to a decision made on their behalf is asking for (#201).
   */
  permissionMinutes: number;
  confirmDelete: boolean;
  /**
   * How many days a deleted session waits in the recycle bin before it is really deleted.
   *
   * Zero means no bin: deleting is immediate and final, which is what this app did before
   * there was one. Anything already in the bin stays there, since it was put there under a
   * different answer and a change about future deletes should not reach back.
   */
  binRetentionDays: number;
  /**
   * Whether new sessions run tools without asking.
   *
   * Applied per session after it is made, because that is the only thing that works:
   * `--allow-all` given to the shared CLI leaves every session it creates asking (#199).
   */
  allowAll: boolean;
  /** Empty means the home directory, which is what the CLI does with no argument. */
  workingDirectory: string;
  /**
   * Which model a new session starts on, or empty for whatever the runtime picks.
   *
   * Empty is the default and means `auto`, which is the runtime's own answer. Naming one
   * also spares the titling a detour: `auto` cannot answer the question a title comes from,
   * so a session on it is moved to a named model and back again (#197).
   */
  defaultModel: string;
  /** How hard it thinks, or empty for whatever the model does by itself. */
  defaultEffort: string;
  /** How much room it has, or empty for the model's ordinary size. */
  defaultContext: string;
  updateOnStart: boolean;
  /**
   * How large everything is drawn, as a multiple of the app's own size.
   *
   * Kept here rather than beside the gesture that used to own it, so there is one answer to
   * what the size is. Two owners of one value meant the settings window could be showing
   * a size the keyboard had already changed (#139).
   */
  scale: number;
  /** How large the letters are, on top of the app scale. One rather than the other. */
  textScale: number;
}

/** The ten minutes the runtime uses when nobody has said otherwise. */
export const DEFAULT_IDLE_MINUTES = 10;

/** The five minutes a question waits when nobody has said otherwise, as the runtime has it. */
export const DEFAULT_PERMISSION_MINUTES = DEFAULT_PERMISSION_TIMEOUT_MS / 60_000;

/** A stored number, or the default when it is absent or was written by something else. */
function number(key: string, fallback: number): number {
  const saved = read('settings', key);
  // Blank counts as absent rather than as zero. Zero is a real answer for both of these -
  // no cap, and never release - and an empty file should not quietly mean either.
  if (saved === null || saved.trim() === '') return fallback;

  const value = Number(saved);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function readSettings(): Settings {
  return {
    maxLoaded: number(MAX_LOADED, 0),
    idleMinutes: number(IDLE_MINUTES, DEFAULT_IDLE_MINUTES),
    permissionMinutes: number(PERMISSION_MINUTES, DEFAULT_PERMISSION_MINUTES),
    // Absent means ask. Only the exact stored false turns it off, so a key holding anything
    // unexpected leaves the question in place rather than silently skipping it.
    confirmDelete: read('settings', CONFIRM_DELETE) !== 'false',
    binRetentionDays: number(BIN_RETENTION_DAYS, DEFAULT_BIN_RETENTION_DAYS),
    // And the same the other way: only the exact stored true gives a new session blanket
    // permission, so nothing unexpected can hand one out.
    allowAll: read('settings', ALLOW_ALL) === 'true',
    workingDirectory: read('settings', WORKING_DIRECTORY) ?? '',
    defaultModel: read('settings', DEFAULT_MODEL) ?? '',
    defaultEffort: read('settings', DEFAULT_EFFORT) ?? '',
    defaultContext: read('settings', DEFAULT_CONTEXT) ?? '',
    updateOnStart: read('settings', UPDATE_ON_START) === 'true',
    // Its own reader: a scale is a fraction, and the one above floors what it is given.
    scale: readScale(),
    textScale: readTextScale(),
  };
}

/**
 * The settings, and a way to change some of them.
 *
 * `apply` takes as many as are being changed at once, because that is what saving a window
 * full of them is: a single decision, not one per field. It is also what keeps the runtime
 * from being told twice when two of its rules change together.
 *
 * The runtime is told about the memory rules whenever they change and once at startup, since
 * it begins every run on its own defaults and has no memory of what was chosen last time.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(readSettings);

  // On every change including the first, so a remembered scale is in force before anything
  // is drawn at the default and then jumps.
  useEffect(() => applyScale(settings.scale, settings.textScale), [settings.scale, settings.textScale]);

  const { maxLoaded, idleMinutes, binRetentionDays, permissionMinutes } = settings;
  useEffect(() => {
    // Failure here is not worth interrupting anyone: the runtime keeps the rules it had,
    // which are the defaults, and the app is still usable.
    void setRuntimeLimits(maxLoaded, idleMinutes * 60_000, binRetentionDays, permissionMinutes * 60_000).catch(
      () => undefined,
    );
  }, [maxLoaded, idleMinutes, binRetentionDays, permissionMinutes]);

  /**
   * Bring the CLI up to date once, if that was asked for.
   *
   * On the setting rather than on every launch, and once rather than on every change:
   * turning it on is a statement about startups, not a request to update now, but an app
   * that is already open when it is turned on would otherwise wait until next time to do
   * anything at all - which reads as the setting not working.
   */
  const asked = useRef(false);
  useEffect(() => {
    if (!settings.updateOnStart || asked.current) return;
    asked.current = true;
    void updateCli().catch(() => undefined);
  }, [settings.updateOnStart]);

  const apply = useCallback((changes: Partial<Settings>) => {
    setSettings((current) => {
      const changed = (Object.keys(changes) as (keyof Settings)[]).filter(
        (key) => changes[key] !== undefined && changes[key] !== current[key],
      );
      // Nothing to do, and returning the same object keeps whatever depends on it still.
      if (changed.length === 0) return current;

      const next = { ...current, ...changes };
      for (const key of changed) save('settings', KEYS[key], String(next[key]));
      return next;
    });
  }, []);

  return { settings, apply };
}

/**
 * What a new session should start with, from the settings.
 *
 * Its own function rather than three arguments read off at the call site, because that is
 * where it kept going untested: App is composition and has no tests, so a setting quietly
 * stopping being passed looked exactly like one that was never wired up (#200).
 *
 * Empty means "say nothing", not "say empty": the runtime has its own answer for each of
 * these, and an empty string is not it.
 */
export function sessionDefaults(settings: Settings): {
  workingDirectory?: string;
  allowAll?: boolean;
  model?: string;
  reasoningEffort?: string;
  contextTier?: string;
} {
  return {
    ...(settings.workingDirectory ? { workingDirectory: settings.workingDirectory } : {}),
    ...(settings.allowAll ? { allowAll: true } : {}),
    // The three travel together: an effort or a room size without a model to apply them to
    // is nothing the runtime can act on.
    ...(settings.defaultModel
      ? {
          model: settings.defaultModel,
          ...(settings.defaultEffort ? { reasoningEffort: settings.defaultEffort } : {}),
          ...(settings.defaultContext ? { contextTier: settings.defaultContext } : {}),
        }
      : {}),
  };
}

/** Which stored key each setting is kept under. */
const KEYS: Record<keyof Settings, string> = {
  maxLoaded: MAX_LOADED,
  idleMinutes: IDLE_MINUTES,
  permissionMinutes: PERMISSION_MINUTES,
  confirmDelete: CONFIRM_DELETE,
  binRetentionDays: BIN_RETENTION_DAYS,
  allowAll: ALLOW_ALL,
  workingDirectory: WORKING_DIRECTORY,
  defaultModel: DEFAULT_MODEL,
  defaultEffort: DEFAULT_EFFORT,
  defaultContext: DEFAULT_CONTEXT,
  updateOnStart: UPDATE_ON_START,
  scale: SCALE_KEY,
  textScale: TEXT_SCALE_KEY,
};
