import type { SlashCommand } from '../../shared/protocol';
import { isLocal } from './localCommands';

/** What is in the composer, as far as commands are concerned. */
export interface Typed {
  /** The command name being written, before any space. Empty for a bare slash. */
  name: string;
  /** What follows the first space, or null when no space has been typed yet. */
  input: string | null;
}

/**
 * Read the composer's text as a command, if that is what it is.
 *
 * A command is one line beginning with a slash, which is also what keeps a pasted path
 * from being read as one: `/usr/bin/env` parses as a command named `usr/bin/env`, matches
 * nothing, and is therefore sent as the text it is.
 */
export function typedCommand(value: string): Typed | null {
  if (!value.startsWith('/') || value.includes('\n')) return null;

  const rest = value.slice(1);
  const space = rest.indexOf(' ');
  if (space === -1) return { name: rest, input: null };
  return { name: rest.slice(0, space), input: rest.slice(space + 1) };
}

/**
 * Whether what was typed after the slash is shaped like a command name at all.
 *
 * The difference between a command nobody has heard of and text that happens to start with
 * a slash. Command names are one bare word of letters, digits and hyphens, so `/help` was
 * meant as a command and is worth complaining about, while `/usr/bin/env`, `/2 of them` and
 * a bare `/` were not and are worth sending as written.
 */
export function looksLikeCommand(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/i.test(name);
}

/** Every name a command answers to. */
function names(command: SlashCommand): string[] {
  return [command.name, ...command.aliases];
}

/**
 * The commands worth offering for what has been typed, best first.
 *
 * Ranked in three bands rather than scored, because the bands are what a reader can
 * predict: what they are typing the start of, what it is another name for, and what merely
 * contains it. Order within a band is the runtime's own, which groups related commands
 * together and is more useful than alphabetical.
 */
export function matchCommands(commands: SlashCommand[], name: string): SlashCommand[] {
  const typed = name.toLowerCase();
  if (!typed) return commands;

  const byName: SlashCommand[] = [];
  const byAlias: SlashCommand[] = [];
  const within: SlashCommand[] = [];

  for (const command of commands) {
    const all = names(command).map((each) => each.toLowerCase());
    if (all[0]!.startsWith(typed)) byName.push(command);
    else if (all.slice(1).some((alias) => alias.startsWith(typed))) byAlias.push(command);
    else if (all.some((each) => each.includes(typed))) within.push(command);
  }

  return [...byName, ...byAlias, ...within];
}

/** The command this text names exactly, under any of its names. */
export function findCommand(commands: SlashCommand[], name: string): SlashCommand | undefined {
  const wanted = name.toLowerCase();
  return commands.find((command) => names(command).some((each) => each.toLowerCase() === wanted));
}

/**
 * The rest of a value, for the ghost drawn ahead of the cursor.
 *
 * Null when what is typed is not the start of it. A row reached by an alias or by a
 * substring cannot be drawn as a continuation of what is in the box, and drawing it anyway
 * would have the ghost contradicting the text. Empty means the value is already whole,
 * which a caller adding a separator after it needs to tell apart from having no match.
 */
export function continuationOf(typed: string, full: string): string | null {
  return full.toLowerCase().startsWith(typed.toLowerCase()) ? full.slice(typed.length) : null;
}

/**
 * The rest of the name, for the ghost the composer draws ahead of the cursor.
 *
 * Only offered when what is typed is the start of the name itself. Completing an alias
 * would replace what was typed with something spelt differently, which reads as the box
 * correcting you rather than finishing your word.
 */
export function completionOf(name: string, command: SlashCommand | undefined): string {
  if (!command || !name) return '';
  return continuationOf(name, command.name) ?? '';
}

/**
 * What the composer should hold once a command is chosen.
 *
 * A command that takes an argument gets a trailing space, so the next keystroke is the
 * argument rather than a correction to the name.
 */
export function commandText(command: SlashCommand): string {
  return command.hint ? `/${command.name} ` : `/${command.name}`;
}

/** What is to be done with what was submitted. */
export type Dispatch =
  /** One this app answers itself, without a session and without the runtime. */
  | { kind: 'local'; command: SlashCommand; input: string }
  /** One the runtime owns, which costs a session to run. */
  | { kind: 'command'; command: SlashCommand; input: string }
  /** Shaped like a command, but there is no such command. */
  | { kind: 'unknown'; name: string; near: SlashCommand[] }
  /** A message for the agent. */
  | { kind: 'text' };

/** How many near-matches to offer for a command that does not exist. */
const SUGGESTIONS = 3;

/**
 * Decide what submitted text is: a command, a command nobody has heard of, or a message.
 *
 * The middle case is the one worth having. Forty of the CLI's commands are drawn by the
 * terminal and unknown to the runtime (#127), so `/help` and its like used to fall past the
 * lookup and reach the agent as an ordinary message - spending a turn on a word that was
 * never meant for it. Naming them costs nothing and says what happened.
 *
 * A slash alone does not make a command: `/usr/bin/env python` and `/2 of them` are text and
 * are sent as written, which is why the shape of the name is what decides, not the slash.
 */
export function dispatch(text: string, commands: SlashCommand[]): Dispatch {
  const typed = typedCommand(text);
  if (!typed) return { kind: 'text' };

  const command = findCommand(commands, typed.name);
  if (command) {
    const kind = isLocal(command.name) ? 'local' : 'command';
    return { kind, command, input: typed.input ?? '' };
  }

  // With nothing to check against, nothing can be said to be unknown - and a message is the
  // one outcome that is never wrong to fall back to.
  if (commands.length === 0 || !looksLikeCommand(typed.name)) return { kind: 'text' };

  return { kind: 'unknown', name: typed.name, near: matchCommands(commands, typed.name).slice(0, SUGGESTIONS) };
}
