import { useCallback, useRef, useState } from 'react';

import { explain } from './errors';
import { listCommands } from './sidecar';
import { LOCAL_COMMANDS, isLocal, withLocalChoices } from './localCommands';
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
/**
 * Versioned because the runtime's input completion metadata changes what the composer can do.
 *
 * An older cached list is otherwise valid enough to keep forever, so it would prevent this
 * build from learning that `/cwd` and `/add-dir` support directory completion.
 */
const REMEMBERED = 'copilot-desktop.commands.v2';

/**
 * Enough runtime metadata to make directory completion useful before the runtime starts.
 *
 * These are the exact definitions reported by the installed CLI. They are a fast seed, not
 * a second source of truth: the lazily fetched runtime list replaces them by name as soon as
 * it arrives.
 */
const BOOTSTRAP_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'add-dir',
    description: 'Allow file access to a directory and load its .github skills and agents as trusted configuration',
    aliases: [],
    hint: 'directory',
    required: true,
    completion: 'directory',
    allowDuringTurn: true,
  },
  {
    name: 'cwd',
    description: 'Change working directory or show current directory',
    aliases: ['cd'],
    hint: 'directory',
    completion: 'directory',
    allowDuringTurn: false,
  },
];
const BOOTSTRAP_NAMES = new Set(BOOTSTRAP_COMMANDS.map((command) => command.name));

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

interface RememberedCommands {
  commands: SlashCommand[];
  /** Whether the cache came from a complete runtime list rather than only the fast seed. */
  runtimeKnown: boolean;
}

function remembered(): RememberedCommands {
  try {
    const stored = localStorage.getItem(REMEMBERED);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    const known = Array.isArray(parsed) && parsed.length > 0 && parsed.every(usable) ? (parsed as SlashCommand[]) : [];
    // Nothing to fold in: the merge adds this app's own commands whatever it is given.
    return {
      commands: merge(known, []),
      runtimeKnown: known.some((command) => !BOOTSTRAP_NAMES.has(command.name)),
    };
  } catch {
    // A corrupt or unreadable entry is worth no more than an absent one.
    return { commands: merge([], []), runtimeKnown: false };
  }
}

/**
 * Fold a fresh answer into what is already known.
 *
 * The two sources are not equivalent: a loaded session knows a handful of commands that
 * only make sense inside a conversation, and a client with no session has never heard of
 * them. Replacing the list would let whichever answer arrived last decide what exists, so a
 * narrower one fills gaps instead of emptying them, while a newer definition of a command
 * already known still wins.
 *
 * Except where the name is one of ours. `/env` exists on both sides, and `isLocal` decides
 * by name what actually runs, so ours are applied last: letting the runtime's description
 * through would leave the menu promising what its version does while this app's answers.
 */
function merge(known: SlashCommand[], found: SlashCommand[]): SlashCommand[] {
  const byName = new Map(BOOTSTRAP_COMMANDS.map((command) => [command.name, command]));
  for (const command of known) byName.set(command.name, command);
  for (const command of found) byName.set(command.name, command);
  for (const command of LOCAL_COMMANDS) byName.set(command.name, command);
  return withLocalChoices([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
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
  const [{ commands: initialCommands, runtimeKnown: initiallyKnown }] = useState(remembered);
  const [commands, setCommands] = useState<SlashCommand[]>(initialCommands);
  const [failed, setFailed] = useState<string | null>(null);
  const runtimeKnown = useRef(initiallyKnown);
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
          runtimeKnown.current = true;
          setCommands((known) => {
            const merged = merge(known, found);
            try {
              // Ours are added back on read from the current definition, so storing them
              // would only preserve a stale copy of something this build already knows.
              localStorage.setItem(REMEMBERED, JSON.stringify(merged.filter((c) => !isLocal(c.name))));
            } catch {
              // Remembering is an optimisation; failing to is not worth reporting.
            }
            return merged;
          });
        })
        .catch((e: unknown) => setFailed(explain(e)))
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

  // Nothing is fetched on mount. The first slash is what asks, and only when the list holds
  // no complete runtime answer. The two seeded directory commands can already complete
  // while that answer starts in the background.
  const open = useCallback(() => {
    if (!runtimeKnown.current) refresh(sessionId);
  }, [refresh, sessionId]);

  return { commands, failed, open, observe };
}
