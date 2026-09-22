import { useCallback, useEffect, useState } from 'react';

import { cliSettingValues, writeCliSettings } from './sidecar';
import { read, save } from './store';

/**
 * The CLI's settings that decide what this app draws.
 *
 * Three of them describe the transcript rather than the terminal - whether thinking is
 * shown, whether each message carries a clock, how long a tool call took - and this app
 * draws all three. It kept its own answer to the first of them, under its own key, which
 * meant one question with two answers that could disagree (#202).
 *
 * So they are read from the CLI's file and written back to it. A reader who turns thinking
 * off here has turned it off in the terminal too, which is what somebody changing "show the
 * model's reasoning" means rather than a coincidence they have to arrange twice.
 *
 * Read as the app starts, which is affordable: the values are a small JSON file. What is
 * expensive is the schema saying what the settings *are*, and nothing here needs that.
 */
export interface CliDisplay {
  showReasoning: boolean;
  showTimestamps: boolean;
  showToolDurations: boolean;
}

/** The key this app used to keep its own answer about thinking under. */
export const OLD_REASONING = 'reasoning';

/**
 * What this app drew before it asked the CLI.
 *
 * Unset means the CLI falls back to a default of its own, which is not written down
 * anywhere this can read - so the answer is what this app already did, and turning one off
 * is a decision somebody has to make rather than one made for them by a missing key.
 */
export const ASSUMED_DISPLAY: CliDisplay = { showReasoning: true, showTimestamps: true, showToolDurations: true };

/** Only the exact stored false turns one off, so nothing unexpected can hide anything. */
function shows(values: Record<string, unknown>, key: keyof CliDisplay): boolean {
  return values[key] !== false;
}

export function useCliDisplay() {
  const [display, setDisplay] = useState<CliDisplay>(ASSUMED_DISPLAY);

  useEffect(() => {
    void cliSettingValues()
      .then((values) => {
        /**
         * What this app was holding under its own key, moved across once.
         *
         * Only when the CLI has no answer of its own: a reader who has set it there has
         * said something more recent than a key this app stopped writing, and carrying the
         * old one over the top of it would undo their choice.
         */
        const held = read('settings', OLD_REASONING);
        if (held !== null && values.showReasoning === undefined) {
          values = { ...values, showReasoning: held !== 'false' };
          void writeCliSettings({ showReasoning: held !== 'false' }).catch(() => undefined);
        }
        // Left in place rather than deleted, so a reader who goes back to an older build
        // finds their setting rather than an app that forgot it.
        setDisplay({
          showReasoning: shows(values, 'showReasoning'),
          showTimestamps: shows(values, 'showTimestamps'),
          showToolDurations: shows(values, 'showToolDurations'),
        });
      })
      // What this app already drew, which is the safe answer: a transcript missing its
      // thinking because a file could not be read would look like lost history.
      .catch(() => undefined);
  }, []);

  /** Turn one on or off, in the CLI's file, where both programs will find it. */
  const set = useCallback((key: keyof CliDisplay, value: boolean) => {
    setDisplay((current) => ({ ...current, [key]: value }));
    // Kept under the old key as well, for a reader who goes back to a build that reads it.
    if (key === 'showReasoning') save('settings', OLD_REASONING, String(value));
    void writeCliSettings({ [key]: value }).catch(() => undefined);
  }, []);

  return { display, set };
}
