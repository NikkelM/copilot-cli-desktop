import type { SlashCommand } from '../../shared/protocol';

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
 * The rest of the name, for the ghost the composer draws ahead of the cursor.
 *
 * Only offered when what is typed is the start of the name itself. Completing an alias
 * would replace what was typed with something spelt differently, which reads as the box
 * correcting you rather than finishing your word.
 */
export function completionOf(name: string, command: SlashCommand | undefined): string {
  if (!command || !name) return '';
  const full = command.name;
  return full.toLowerCase().startsWith(name.toLowerCase()) ? full.slice(name.length) : '';
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

/** Whether a command has everything it needs to run. */
export function isReady(command: SlashCommand, input: string | null): boolean {
  return !command.required || (input ?? '').trim().length > 0;
}
