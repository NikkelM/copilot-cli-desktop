import type { SlashCommand } from '../../shared/protocol';

/**
 * Show every key and every command, as the CLI's own `/help` does.
 *
 * Answered here rather than by the runtime, which has never heard of it: the runtime's list
 * is the CLI's engine, not its interface, and `/help` is one of forty commands the terminal
 * draws for itself (#127). Typed here it reached nothing and was sent to the agent as an
 * ordinary message, which spent a turn on it.
 *
 * Being ours also makes it free. Everything the runtime owns costs a session to run; this
 * costs nothing, which is the right price for reading a list.
 */
export const HELP: SlashCommand = {
  name: 'help',
  description: 'show full help',
  aliases: [],
  allowDuringTurn: true,
};

/**
 * The commands this app answers itself.
 *
 * Folded into the runtime's list so they are offered by the menu alongside it - the reader
 * has no reason to care which side of the wire answers them.
 */
export const LOCAL_COMMANDS: readonly SlashCommand[] = [HELP];

/** Whether a command is one of ours, and so must not be sent to the runtime. */
export function isLocal(name: string): boolean {
  return LOCAL_COMMANDS.some((command) => command.name === name);
}
