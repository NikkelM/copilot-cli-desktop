import { useCallback, useRef, useState } from 'react';

import { listCommands } from './sidecar';
import type { SlashCommand } from '../../shared/protocol';

/**
 * Where the command list is kept between runs.
 *
 * Asking the runtime costs a server process, which is the one thing this app will not spend
 * on something nobody asked for. But the list is what makes a slash worth typing at all, so
 * an empty one on first use would hide the feature from anyone who does not already know it
 * is there. Remembering it means that cost is paid once, ever, and then only because
 * somebody opened the list.
 */
const REMEMBERED = 'copilot-desktop.commands';

/**
 * A remembered entry is only usable if it still matches what this version expects.
 *
 * What is stored outlives the code that stored it, and a command missing the fields the
 * menu reads would render as a blank row rather than fail visibly.
 */
function usable(value: unknown): value is SlashCommand {
  const command = value as SlashCommand | null;
  return (
    typeof command?.name === 'string' &&
    typeof command.description === 'string' &&
    Array.isArray(command.aliases) &&
    typeof command.allowDuringTurn === 'boolean'
  );
}

function remembered(): SlashCommand[] {
  try {
    const stored = localStorage.getItem(REMEMBERED);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(usable) ? (parsed as SlashCommand[]) : [];
  } catch {
    // A corrupt or unreadable entry is worth no more than an absent one.
    return [];
  }
}

/**
 * The slash commands there are.
 *
 * Seeded from what was remembered so the menu has something to show the instant a slash is
 * typed, and refreshed behind that from whichever session is open. A loaded session knows
 * about a few more than the runtime does in general, so the answer improves once one is
 * awake without anything being woken to bring that about.
 */
export function useCommands(sessionId: string | null) {
  const [commands, setCommands] = useState<SlashCommand[]>(remembered);
  const [failed, setFailed] = useState<string | null>(null);
  /** Set while a fetch is in flight, so opening the menu repeatedly asks once. */
  const asking = useRef(false);

  const refresh = useCallback(
    (forSession: string | null) => {
      if (asking.current) return;
      asking.current = true;
      setFailed(null);

      listCommands(forSession ?? undefined)
        .then((found) => {
          if (found.length === 0) return;
          setCommands(found);
          try {
            localStorage.setItem(REMEMBERED, JSON.stringify(found));
          } catch {
            // Remembering is an optimisation; failing to is not worth reporting.
          }
        })
        .catch((e: unknown) => setFailed(String(e)))
        .finally(() => (asking.current = false));
    },
    [],
  );

  /**
   * Take the better list once a session is awake, since one is already running.
   *
   * Deliberately not a fetch on every session change: a cold session would answer from the
   * runtime at large, which is the list already held, at the price of starting a server.
   */
  const observe = useCallback(
    (loaded: boolean, forSession: string) => {
      if (loaded) refresh(forSession);
    },
    [refresh],
  );

  // Nothing is fetched on mount. The first slash is what asks, and only when there is
  // nothing remembered to answer with.
  const open = useCallback(() => {
    if (commands.length === 0) refresh(sessionId);
  }, [commands.length, refresh, sessionId]);

  return { commands, failed, open, observe };
}
