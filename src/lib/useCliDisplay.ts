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
  /** Whether the taskbar button says a session is working, which this app paints as the CLI does. */
  taskbarPresence: boolean;
  showTimestamps: boolean;
  showToolDurations: boolean;
  /** How many of the newest prompts can be stepped back through. */
  commandHistoryMaxSize: number;
  /**
   * What the CLI's own footer shows, for the parts of it this app draws too (#130).
   *
   * `/statusline` and its `/footer` alias look like terminal configuration and are not:
   * every toggle names something a reader has decided they do or do not want to see, and
   * most of them name something this window has its own version of. Answering to them means
   * one place to configure both tools rather than two.
   *
   * Read only, unlike the switches above. This app offers no control over them, so there is
   * nothing here that could write one - the CLI's own command is where they are set.
   *
   * Nested, unlike everything else here: the CLI spells these `footer.showDirectory` and
   * keeps them in an object of that name. Nothing writes the object until `/statusline`
   * does, so an install that has never run it has no `footer` key at all.
   */
  footer: FooterParts;
}

/** The footer toggles this window has somewhere to apply. The CLI has nine more. */
export interface FooterParts {
  /** The working directory, which this app draws as the path in the header. */
  showDirectory: boolean;
  /** The branch, drawn beside the path. */
  showBranch: boolean;
  /** How full the window is, which this app draws inside the model picker. */
  showContextWindow: boolean;
  /** The model and its effort, drawn as the picker's own label. */
  showModelEffort: boolean;
  /** The agent, drawn as the agent picker. */
  showAgent: boolean;
  /** What the session changed, drawn as the Changes button. */
  showCodeChanges: boolean;
}

/** The ones that are a switch, which are the ones this app offers to flip. */
type Toggle = {
  [K in keyof CliDisplay]: CliDisplay[K] extends boolean ? K : never;
}[keyof CliDisplay];

/**
 * What the CLI says about its own history size, and how far it will be believed.
 *
 * The bounds are the CLI's, quoted in the schema: "1-1000. Defaults to 50." Held to here
 * as well, because this reads a file somebody can type anything into, and a zero would
 * leave the reader unable to recall the prompt they just sent with no way to see why.
 */
export const HISTORY_DEFAULT = 50;
const HISTORY_MIN = 1;
const HISTORY_MAX = 1000;

function historySize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return HISTORY_DEFAULT;
  return Math.min(HISTORY_MAX, Math.max(HISTORY_MIN, Math.floor(value)));
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
export const ASSUMED_DISPLAY: CliDisplay = {
  showReasoning: true,
  taskbarPresence: true,
  showTimestamps: true,
  showToolDurations: true,
  commandHistoryMaxSize: HISTORY_DEFAULT,
  footer: {
    showDirectory: true,
    showBranch: true,
    showContextWindow: true,
    showModelEffort: true,
    showAgent: true,
    showCodeChanges: true,
  },
};

/** Only the exact stored false turns one off, so nothing unexpected can hide anything. */
function shows(values: Record<string, unknown>, key: Toggle): boolean {
  return values[key] !== false;
}

/**
 * The same rule one level down, for the settings the CLI keeps in an object.
 *
 * An install that has never run `/statusline` has no `footer` key at all, and one that has
 * only carries the toggles that were changed - so anything missing is what the CLI shows by
 * default, which is everything.
 */
function footerParts(values: Record<string, unknown>): FooterParts {
  const held = values.footer;
  const footer = typeof held === 'object' && held !== null ? (held as Record<string, unknown>) : {};

  return {
    showDirectory: footer.showDirectory !== false,
    showBranch: footer.showBranch !== false,
    showContextWindow: footer.showContextWindow !== false,
    showModelEffort: footer.showModelEffort !== false,
    showAgent: footer.showAgent !== false,
    showCodeChanges: footer.showCodeChanges !== false,
  };
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
          taskbarPresence: shows(values, 'taskbarPresence'),
          showTimestamps: shows(values, 'showTimestamps'),
          showToolDurations: shows(values, 'showToolDurations'),
          commandHistoryMaxSize: historySize(values.commandHistoryMaxSize),
          footer: footerParts(values),
        });
      })
      // What this app already drew, which is the safe answer: a transcript missing its
      // thinking because a file could not be read would look like lost history.
      .catch(() => undefined);
  }, []);

  /** Turn one on or off, in the CLI's file, where both programs will find it. */
  const set = useCallback((key: Toggle, value: boolean) => {
    setDisplay((current) => ({ ...current, [key]: value }));
    // Kept under the old key as well, for a reader who goes back to a build that reads it.
    if (key === 'showReasoning') save('settings', OLD_REASONING, String(value));
    void writeCliSettings({ [key]: value }).catch(() => undefined);
  }, []);

  /**
   * Fold in a change made somewhere else in this app.
   *
   * The settings window writes the CLI's file directly, since these are the CLI's settings
   * and holding a draft of another program's file would only invite the two to disagree.
   * That write does not come back through here, so without this a reader who turned
   * timestamps off in that window would see nothing change until the app was next started.
   *
   * Only the settings this app draws from are taken; the rest of that file is the CLI's.
   */
  const take = useCallback((changes: Record<string, unknown>) => {
    setDisplay((current) => {
      const next = { ...current };
      for (const key of Object.keys(changes)) {
        if (key === 'commandHistoryMaxSize') next.commandHistoryMaxSize = historySize(changes[key]);
        else if (key in ASSUMED_DISPLAY) next[key as Toggle] = shows(changes, key as Toggle);
      }
      return next;
    });
  }, []);

  return { display, set, take };
}
