import { useCallback, useEffect, useState } from 'react';

import { read, save } from './store';
import { setRuntimeLimits } from './sidecar';

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

export interface Settings {
  /** Zero means no cap, which is what the runtime starts with. */
  maxLoaded: number;
  /** Zero means never, which is a real choice on a machine with memory to spare. */
  idleMinutes: number;
  confirmDelete: boolean;
}

/** The ten minutes the runtime uses when nobody has said otherwise. */
export const DEFAULT_IDLE_MINUTES = 10;

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
    // Absent means ask. Only the exact stored false turns it off, so a key holding anything
    // unexpected leaves the question in place rather than silently skipping it.
    confirmDelete: read('settings', CONFIRM_DELETE) !== 'false',
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

  const { maxLoaded, idleMinutes } = settings;
  useEffect(() => {
    // Failure here is not worth interrupting anyone: the runtime keeps the rules it had,
    // which are the defaults, and the app is still usable.
    void setRuntimeLimits(maxLoaded, idleMinutes * 60_000).catch(() => undefined);
  }, [maxLoaded, idleMinutes]);

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

/** Which stored key each setting is kept under. */
const KEYS: Record<keyof Settings, string> = {
  maxLoaded: MAX_LOADED,
  idleMinutes: IDLE_MINUTES,
  confirmDelete: CONFIRM_DELETE,
};
