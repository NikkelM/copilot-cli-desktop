import { useCallback, useRef, useState } from 'react';

import { cliSettings, writeCliSettings } from './sidecar';
import { explain } from './errors';
import type { CliSetting } from '../../shared/protocol';

/** What the CLI knows about and what it is set to, which are only useful together. */
export interface CliSettingsState {
  settings: CliSetting[];
  /** Only what the reader has chosen. A missing path is one the CLI decides for itself. */
  values: Record<string, unknown>;
}

/**
 * The Copilot CLI's own settings, read from the CLI the reader actually has.
 *
 * Nothing is read until somebody asks: the schema comes out of a 90MB binary, and while
 * that is 60ms rather than a second, it is 60ms nobody changing the text size asked for.
 *
 * Writing reaches a running session. The CLI reads its settings when a session is created
 * rather than caching them when its server starts, so there is nothing to restart and
 * nothing to warn anybody about (#202).
 */
export function useCliSettings(onError?: (message: string) => void) {
  const [state, setState] = useState<CliSettingsState | null>(null);

  const report = useRef(onError);
  report.current = onError;

  const refresh = useCallback(() => {
    setState(null);
    void cliSettings()
      .then(setState)
      // An empty schema is what a CLI laid out differently gives, and the window already
      // has something to say about that. A window stuck loading for ever does not.
      .catch(() => setState({ settings: [], values: {} }));
  }, []);

  /**
   * Write some of them, and hold what was written rather than reading the file again.
   *
   * The file is this app's own doing at that point, so re-reading it would only be asking
   * the disk to confirm what was just sent - and a failure is reported instead, which is
   * the case where what is shown and what is stored could actually differ.
   */
  const write = useCallback((changes: Record<string, unknown>) => {
    setState((current) => {
      if (!current) return current;
      const values = { ...current.values };
      for (const [path, value] of Object.entries(changes)) {
        if (value === null || value === undefined) delete values[path];
        else values[path] = value;
      }
      return { ...current, values };
    });

    void writeCliSettings(changes).catch((e: unknown) => {
      report.current?.(explain(e));
      // Put back whatever is really there, since what is on screen was this app's guess.
      void cliSettings().then(setState).catch(() => undefined);
    });
  }, []);

  return { cli: state, refresh, write };
}
