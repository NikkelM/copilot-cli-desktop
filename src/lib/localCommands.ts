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
 * The commands this app answers itself.
 *
 * Folded into the runtime's list so they are offered by the menu alongside it - the reader
 * has no reason to care which side of the wire answers them.
 */
export const LOCAL_COMMANDS: readonly SlashCommand[] = [HELP, CHANGES, ENVIRONMENT];

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

/**
 * Commands whose argument is a directory, and whether one is required.
 *
 * Verified against the runtime rather than assumed. `/add-dir` with no argument fails with
 * a usage line, so there is nothing to lose by opening a picker instead. `/cwd` with no
 * argument reports the current directory, which is useful and is not ours to take away -
 * so it is offered by name and never by omission.
 */
const DIRECTORY_COMMANDS: Readonly<Record<string, { readonly required: boolean }>> = {
  'add-dir': { required: true },
  cwd: { required: false },
};

/** Whether this command and argument should be answered by a folder picker. */
export function wantsDirectory(name: string, input: string): boolean {
  const command = DIRECTORY_COMMANDS[name];
  if (!command) return false;

  const argument = input.trim();
  return argument.toLowerCase() === BROWSE || (argument === '' && command.required);
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
  'add-dir': [{ name: BROWSE, description: 'choose the directory with a folder picker' }],
  cwd: [{ name: BROWSE, description: 'choose the directory with a folder picker' }],
};

/**
 * Add the arguments this app answers to the commands the runtime described.
 *
 * By name rather than by appending, so folding a list that has already been through here -
 * a remembered one, say - does not offer the same choice twice.
 */
export function withLocalChoices(commands: SlashCommand[]): SlashCommand[] {
  return commands.map((command) => {
    const extra = LOCAL_CHOICES[command.name];
    if (!extra) return command;

    const known = command.choices ?? [];
    const missing = extra.filter((choice) => !known.some((each) => each.name === choice.name));
    return missing.length === 0 ? command : { ...command, choices: [...known, ...missing] };
  });
}
