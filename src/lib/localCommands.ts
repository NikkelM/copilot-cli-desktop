import type { CommandChoice, SlashCommand } from '../../shared/protocol';

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
 * Show what this session changed, which is a panel here rather than a scrollback dump.
 *
 * The CLI's nearest equivalent is `/diff`, which reviews the working directory - a
 * different question, since it counts anything anyone changed. This one is scoped to the
 * session's own edits. `/diff` is kept as an alias so the CLI's word finds it, because
 * looking at a diff is what both are for.
 *
 * Free, like `/help`: the rewind snapshots are files, so nothing has to be running.
 */
export const CHANGES: SlashCommand = {
  name: 'changes',
  description: 'review what this session changed',
  aliases: ['diff'],
  allowDuringTurn: true,
};

/**
 * Show what a session in this directory would load, as a panel rather than a scrollback dump.
 *
 * Takes the runtime's own `/env` name deliberately. Both answer the same question, and two
 * commands for it would be a menu that has to be explained. Ours reads files rather than a
 * session, so it costs nothing and answers for a session that has never been opened, and it
 * renders the instruction files rather than only listing their paths.
 *
 * The runtime's version covers more: MCP servers, skills, agents, hooks and LSPs as well
 * (#165). Those sections are still to come, and until they do this shows less than the CLI
 * does for the same word.
 */
export const ENVIRONMENT: SlashCommand = {
  name: 'env',
  description: 'show the instructions, plugins and extensions loaded here',
  aliases: [],
  allowDuringTurn: true,
};

/**
 * Show what this session has cost, which the runtime does not offer as a command.
 *
 * `/usage` is one of the forty the CLI's terminal keeps to itself (#127): the runtime lists
 * twenty-eight and this is not among them, so forwarding it reaches nothing and the word
 * would be sent to the agent as an ordinary message.
 *
 * Free for a cold session as well as a loaded one, which the CLI's own is not: what a
 * session has spent is written to its log as it goes, so this is a read rather than a
 * resume (#12).
 */
export const USAGE: SlashCommand = {
  name: 'usage',
  description: 'show what this session has cost',
  aliases: [],
  allowDuringTurn: true,
};

/**
 * The commands this app answers itself.
 *
 * Folded into the runtime's list so they are offered by the menu alongside it - the reader
 * has no reason to care which side of the wire answers them.
 */
export const LOCAL_COMMANDS: readonly SlashCommand[] = [HELP, CHANGES, ENVIRONMENT, USAGE];

/** Whether a command is one of ours, and so must not be sent to the runtime. */
export function isLocal(name: string): boolean {
  return LOCAL_COMMANDS.some((command) => command.name === name);
}

/**
 * The word that asks for a folder picker instead of a typed path.
 *
 * An ordinary word rather than a symbol, because it has to read as an option in the menu
 * beside `on` and `off`. It is therefore also a directory name somebody could in principle
 * own, and `/add-dir browse` would pick rather than add it - reachable anyway by writing
 * `.\browse` or the full path, and cancelling the picker costs nothing.
 */
export const BROWSE = 'browse';

/** Whether this command and argument should be answered by a folder picker. */
export function wantsDirectory(command: SlashCommand, input: string): boolean {
  if (command.completion !== 'directory') return false;
  const argument = input.trim();
  return argument.toLowerCase() === BROWSE || (argument === '' && command.required === true);
}

/**
 * Arguments that name an MCP server, and the word that introduces them.
 *
 * `/mcp` takes a subcommand and three of them take a server name after it. The runtime
 * describes the subcommands as flat choices and says nothing about what follows one, so
 * which of them wants a name is known here rather than read off the command.
 *
 * `list` and `reload` take nothing further, and offering names after them would suggest an
 * argument the runtime would reject.
 */
const SERVER_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  mcp: ['show', 'enable', 'disable'],
};

/**
 * Whether this command takes a server name after any of its subcommands.
 *
 * Asked before a subcommand has been typed, so the list can be on its way while it is
 * being written. The first discovery costs about 0.8 s once the runtime is up, and several
 * seconds when it is not, which is far too long to begin paying at the moment the argument
 * is reached.
 */
export function takesServerName(command: SlashCommand): boolean {
  return SERVER_ARGUMENTS[command.name] !== undefined;
}

/**
 * The part of an argument that is a half-typed server name, if that is what it is.
 *
 * Null when the command wants no server, when no subcommand has been finished with a space,
 * or when the subcommand is one that takes nothing further. The empty string is a real
 * answer and means every server matches: `/mcp disable ` has named none of them yet.
 */
export function typedServerName(command: SlashCommand, input: string): string | null {
  const wants = SERVER_ARGUMENTS[command.name];
  if (!wants) return null;

  const space = input.indexOf(' ');
  if (space === -1) return null;

  const subcommand = input.slice(0, space).toLowerCase();
  return wants.includes(subcommand) ? input.slice(space + 1) : null;
}

/**
 * Arguments this app answers for commands the runtime owns.
 *
 * `/session id` is the terminal's own: the runtime's `/session` offers
 * info|checkpoints|files|plan|rename and answers `id` with a usage line, while the CLI adds
 * it and handles it locally (#129). This app holds the id too, so it answers it as well -
 * and the menu has to offer it, or the only way to find it is to already know.
 *
 * `browse` is ours everywhere a command wants a directory. A path is the one argument a
 * window can supply better than a keyboard can, and offering it as a choice is what makes
 * it findable: nobody guesses a word that appears nowhere.
 */
const LOCAL_CHOICES: Readonly<Record<string, readonly CommandChoice[]>> = {
  session: [{ name: 'id', description: 'copy this session id to the clipboard' }],
};

const DIRECTORY_CHOICE: CommandChoice = {
  name: BROWSE,
  description: 'choose the directory with a folder picker',
};

/**
 * Add the arguments this app answers to the commands the runtime described.
 *
 * By name rather than by appending, so folding a list that has already been through here -
 * a remembered one, say - does not offer the same choice twice.
 */
export function withLocalChoices(commands: SlashCommand[]): SlashCommand[] {
  return commands.map((command) => {
    const extra = [
      ...(LOCAL_CHOICES[command.name] ?? []),
      ...(command.completion === 'directory' ? [DIRECTORY_CHOICE] : []),
    ];
    if (extra.length === 0) return command;

    const known = command.choices ?? [];
    const missing = extra.filter((choice) => !known.some((each) => each.name === choice.name));
    return missing.length === 0 ? command : { ...command, choices: [...known, ...missing] };
  });
}
