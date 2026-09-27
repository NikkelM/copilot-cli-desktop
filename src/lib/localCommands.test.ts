import { describe, expect, it } from 'vitest';

import {
  BROWSE,
  LOCAL_COMMANDS,
  REWIND,
  TAG,
  isLocal,
  readMcpCommand,
  readRewindCommand,
  typedRewindScope,
  typedServerName,
  wantsDirectory,
  withLocalChoices,
  withRewindChoices,
  withTagChoices,
} from './localCommands';
import type { RewindPoint, SlashCommand } from '../../shared/protocol';

const command = (over: Partial<SlashCommand> = {}): SlashCommand => ({
  name: 'session',
  description: 'session commands',
  aliases: [],
  allowDuringTurn: false,
  ...over,
});

describe('isLocal', () => {
  it('knows the commands this app answers itself', () => {
    for (const each of LOCAL_COMMANDS) expect(isLocal(each.name)).toBe(true);
  });

  it('leaves the runtime its own', () => {
    expect(isLocal('session')).toBe(false);
    expect(isLocal('model')).toBe(false);
  });

  /**
   * `/env` is the one name both sides define. Taking it is deliberate, and the consequence
   * is that the runtime's version no longer runs, so it should never happen by accident.
   */
  it('takes /env from the runtime deliberately', () => {
    expect(isLocal('env')).toBe(true);
  });
});

/**
 * `/session id` is the terminal's own, not the runtime's, so the menu has to offer it or
 * the only way to find it is to already know (#129).
 */
describe('withLocalChoices', () => {
  it('offers the argument this app answers', () => {
    const [session] = withLocalChoices([command()]);
    expect(session!.choices).toEqual([{ name: 'id', description: 'copy this session id to the clipboard' }]);
  });

  it('keeps the arguments the runtime described', () => {
    const [session] = withLocalChoices([command({ choices: [{ name: 'info', description: 'session info' }] })]);
    expect(session!.choices?.map((c) => c.name)).toEqual(['info', 'id']);
  });

  /** A remembered list has already been through here, and would otherwise grow every run. */
  it('does not offer the same argument twice', () => {
    const once = withLocalChoices([command()]);
    const twice = withLocalChoices(once);
    expect(twice[0]!.choices).toHaveLength(1);
  });

  it('leaves commands it has nothing to add to exactly as they were', () => {
    const model = command({ name: 'model' });
    expect(withLocalChoices([model])[0]).toBe(model);
  });

  it('would defer to the runtime if it ever grew the argument itself', () => {
    const mine = { name: 'id', description: 'the runtime version' };
    const [session] = withLocalChoices([command({ choices: [mine] })]);
    expect(session!.choices).toEqual([mine]);
  });
});

/**
 * A directory is the one argument a window supplies better than a keyboard, so the commands
 * that want one are answered with a picker. Verified against the runtime rather than
 * assumed: `/add-dir` with nothing after it fails with a usage line, while `/cwd` with
 * nothing after it reports where the session is.
 */
describe('wantsDirectory', () => {
  it.each(['add-dir', 'cwd'])('offers the picker when %s is asked for it by name', (name) => {
    expect(wantsDirectory(command({ name, completion: 'directory' }), BROWSE)).toBe(true);
  });

  /** Typed rather than chosen from the menu, which is the same request spelt by hand. */
  it('ignores the case it was typed in', () => {
    const add = command({ name: 'add-dir', completion: 'directory', required: true });
    expect(wantsDirectory(add, 'Browse')).toBe(true);
    expect(wantsDirectory(add, '  browse  ')).toBe(true);
  });

  /** Nothing is lost: the runtime answers a bare /add-dir with a usage line and no more. */
  it('offers the picker for a bare /add-dir, which would otherwise only fail', () => {
    const add = command({ name: 'add-dir', completion: 'directory', required: true });
    expect(wantsDirectory(add, '')).toBe(true);
    expect(wantsDirectory(add, '   ')).toBe(true);
  });

  /**
   * The one case that must not be taken. A bare /cwd reports the current directory, which
   * is useful and is not ours to replace with a window nobody asked for.
   */
  it('leaves a bare /cwd alone, because it already answers', () => {
    expect(wantsDirectory(command({ name: 'cwd', completion: 'directory' }), '')).toBe(false);
  });

  it('leaves a path that was actually typed alone', () => {
    const add = command({ name: 'add-dir', completion: 'directory', required: true });
    const cwd = command({ name: 'cwd', completion: 'directory' });
    expect(wantsDirectory(add, 'C:\\work\\repo')).toBe(false);
    expect(wantsDirectory(cwd, '/home/user/projects')).toBe(false);
  });

  it('has nothing to say about commands that do not want a directory', () => {
    expect(wantsDirectory(command({ name: 'model' }), BROWSE)).toBe(false);
    expect(wantsDirectory(command({ name: 'session' }), '')).toBe(false);
  });
});

/** The word has to appear in the menu, or the only way to find it is to already know. */
describe('the browse choice', () => {
  it.each(['add-dir', 'cwd'])('is offered on %s', (name) => {
    const [found] = withLocalChoices([command({ name, completion: 'directory' })]);
    expect(found!.choices?.map((c) => c.name)).toContain(BROWSE);
  });

  it('is not offered on commands that take no directory', () => {
    const [model] = withLocalChoices([command({ name: 'model' })]);
    expect(model!.choices?.map((c) => c.name) ?? []).not.toContain(BROWSE);
  });

  it('follows the runtime hint rather than a hardcoded command name', () => {
    const [future] = withLocalChoices([command({ name: 'future-path', completion: 'directory' })]);
    expect(future!.choices?.map((c) => c.name)).toContain(BROWSE);
  });
});
/**
 * `/mcp` takes a subcommand and three of them take a server name after it. The runtime
 * describes the subcommands as flat choices and says nothing about what follows one, so
 * which of them wants a name is this app's knowledge rather than the command's.
 */
describe('typedServerName', () => {
  const mcp = command({ name: 'mcp' });

  it.each(['show', 'enable', 'disable'])('offers a name after %s', (subcommand) => {
    expect(typedServerName(mcp, `${subcommand} con`)).toBe('con');
  });

  /** The space is what finishes the subcommand; before it, the subcommand is still being typed. */
  it('says nothing until the subcommand is finished', () => {
    expect(typedServerName(mcp, 'disable')).toBeNull();
    expect(typedServerName(mcp, 'disa')).toBeNull();
  });

  // An empty name is a real answer: every server matches until one is named.
  it('treats a finished subcommand with nothing after it as matching everything', () => {
    expect(typedServerName(mcp, 'disable ')).toBe('');
  });

  /** Offering a name after these would suggest an argument the runtime would refuse. */
  it.each(['list', 'reload'])('says nothing after %s, which takes no server', (subcommand) => {
    expect(typedServerName(mcp, `${subcommand} `)).toBeNull();
  });

  it('ignores the case the subcommand was typed in', () => {
    expect(typedServerName(mcp, 'Disable con')).toBe('con');
  });

  it('has nothing to say about other commands', () => {
    expect(typedServerName(command({ name: 'model' }), 'disable con')).toBeNull();
    expect(typedServerName(command({ name: 'cwd' }), 'disable con')).toBeNull();
  });

  // A server name can be anything, including something with a space in it.
  it('keeps the rest of the argument whole', () => {
    expect(typedServerName(mcp, 'disable my server')).toBe('my server');
  });
});

describe('withTagChoices', () => {
  const commands = [command({ name: 'tag' }), command({ name: 'git' })];

  it('offers each tag there is as an argument', () => {
    const [tag] = withTagChoices(commands, ['bug', 'spike'], []);

    expect(tag?.choices?.map((c) => c.name)).toEqual(['bug', 'spike']);
  });

  it('says what choosing one would do, which depends on the session', () => {
    // Tagging is a toggle, so the same name means opposite things on two sessions.
    const [tag] = withTagChoices(commands, ['bug', 'spike'], ['bug']);

    expect(tag?.choices).toEqual([
      { name: 'bug', description: 'remove from this session' },
      { name: 'spike', description: 'add to this session' },
    ]);
  });

  it('leaves every other command alone', () => {
    const [, git] = withTagChoices(commands, ['bug'], []);

    expect(git?.choices).toBeUndefined();
  });

  it('changes nothing when nothing has been tagged', () => {
    expect(withTagChoices(commands, [], [])).toBe(commands);
  });

  it('replaces what was offered rather than adding to it', () => {
    // A tag retired between two openings of the menu must not still be offered.
    const stale = [command({ name: 'tag', choices: [{ name: 'gone', description: 'add to this session' }] })];

    const [tag] = withTagChoices(stale, ['bug'], []);

    expect(tag?.choices?.map((c) => c.name)).toEqual(['bug']);
  });
});

describe('the tag command', () => {
  it('is answered by this app rather than the runtime', () => {
    expect(isLocal('tag')).toBe(true);
    expect(LOCAL_COMMANDS).toContain(TAG);
  });

  it('runs while a turn is in flight, since it touches nothing the agent is doing', () => {
    expect(TAG.allowDuringTurn).toBe(true);
  });

  it('does not insist on an argument, since naming none opens the picker', () => {
    expect(TAG.required).toBeUndefined();
  });
});
/**
 * Reading the line `/mcp` was given. Three subcommands rather than one action, because they
 * are not variations of each other (#24).
 */
describe('readMcpCommand', () => {
  it('opens the panel when nothing was asked for', () => {
    expect(readMcpCommand('')).toEqual({ kind: 'panel' });
    expect(readMcpCommand('   ')).toEqual({ kind: 'panel' });
  });

  it('reads the three it knows', () => {
    expect(readMcpCommand('add')).toEqual({ kind: 'add' });
    expect(readMcpCommand('edit context7')).toEqual({ kind: 'edit', name: 'context7' });
    expect(readMcpCommand('delete context7')).toEqual({ kind: 'delete', name: 'context7' });
  });

  it('does not mind how it was capitalised', () => {
    expect(readMcpCommand('ADD')).toEqual({ kind: 'add' });
    expect(readMcpCommand('Edit c7')).toEqual({ kind: 'edit', name: 'c7' });
  });

  /**
   * The rest of the line is the name rather than the next argument: the config is a JSON
   * object whose keys are free text, so a server called "my server" is possible.
   */
  it('keeps a name with a space in it whole', () => {
    expect(readMcpCommand('delete my server')).toEqual({ kind: 'delete', name: 'my server' });
  });

  it('is not troubled by the spacing', () => {
    expect(readMcpCommand('  edit   context7  ')).toEqual({ kind: 'edit', name: 'context7' });
  });

  /** Whatever the composer put between them, which is not always a plain space. */
  it('separates the verb from the name on any whitespace', () => {
    expect(readMcpCommand('edit\tcontext7')).toEqual({ kind: 'edit', name: 'context7' });
  });

  /** A verb with no name is answerable: the reader said what they want and left out which. */
  it('says which name is missing rather than refusing the whole line', () => {
    expect(readMcpCommand('edit')).toEqual({ kind: 'needs-name', verb: 'edit' });
    expect(readMcpCommand('delete')).toEqual({ kind: 'needs-name', verb: 'delete' });
  });

  it('names a verb it does not know', () => {
    expect(readMcpCommand('destroy context7')).toEqual({ kind: 'unknown', verb: 'destroy' });
  });

  /** The CLI takes a name after `add` as a prefill for the new server rather than a target. */
  it('carries a name given to add, for the form to open on', () => {
    expect(readMcpCommand('add something')).toEqual({ kind: 'add', name: 'something' });
  });

  it('leaves the name out where add was given none', () => {
    expect(readMcpCommand('add')).not.toHaveProperty('name');
  });

  /** The CLI has both, and they mean the same thing. */
  it('reads list as the bare form written out', () => {
    expect(readMcpCommand('list')).toEqual({ kind: 'panel' });
  });
});
/**
 * Putting a session back to an earlier turn (#156).
 *
 * Both arguments are chosen from the composer's own menu, so neither is a word anybody has
 * to know - but the line they produce still has to be read back.
 */
describe('the rewind command', () => {
  const point = (eventId: string, message: string, over: Partial<RewindPoint> = {}): RewindPoint => ({
    eventId,
    message,
    at: '2026-09-27T10:00:00.000Z',
    canRestoreFiles: true,
    fileCount: 1,
    linesAdded: 3,
    linesRemoved: 1,
    ...over,
  });

  const points = [point('e1', 'first thing'), point('e2', 'second thing'), point('e3', 'third thing')];

  describe('withRewindChoices', () => {
    /** As the CLI numbers them: the turn wanted is usually recent, and that is how it is thought of. */
    it('numbers the turns from the end', () => {
      const [rewind] = withRewindChoices([REWIND], points).filter((c) => c.name === 'rewind');

      expect(rewind?.choices?.map((choice) => choice.name)).toEqual(['3', '2', '1']);
    });

    it('says what each turn asked, since a number identifies nothing', () => {
      const [rewind] = withRewindChoices([REWIND], points).filter((c) => c.name === 'rewind');

      expect(rewind?.choices?.[0]?.description).toContain('first thing');
      expect(rewind?.choices?.[2]?.description).toContain('third thing');
    });

    it('says what a turn came to when it changed something', () => {
      const [rewind] = withRewindChoices([REWIND], points).filter((c) => c.name === 'rewind');

      expect(rewind?.choices?.[0]?.description).toContain('+3 −1');
    });

    // Zeroes beside every turn that only talked would be noise.
    it('says nothing about counts for a turn that changed nothing', () => {
      const quiet = [point('e1', 'just talked', { fileCount: 0, linesAdded: 0, linesRemoved: 0 })];
      const [rewind] = withRewindChoices([REWIND], quiet).filter((c) => c.name === 'rewind');

      expect(rewind?.choices?.[0]?.description).toBe('just talked');
    });

    it('leaves the commands alone when there is nothing to go back to', () => {
      expect(withRewindChoices([REWIND], [])).toEqual([REWIND]);
    });

    it('leaves the other commands alone', () => {
      const [tag] = withRewindChoices([TAG, REWIND], points).filter((c) => c.name === 'tag');

      expect(tag).toEqual(TAG);
    });
  });

  describe('typedRewindScope', () => {
    // Until a turn has been finished with a space, the reader is still choosing the turn.
    it.each([[''], ['3'], ['  ']])('offers nothing for %s', (input) => {
      expect(typedRewindScope(REWIND, input)).toBeNull();
    });

    it('offers both scopes once a turn has been finished', () => {
      expect(typedRewindScope(REWIND, '3 ')).toEqual({ turn: 3, partial: '' });
    });

    it('carries what has been typed of the scope', () => {
      expect(typedRewindScope(REWIND, '3 fi')).toEqual({ turn: 3, partial: 'fi' });
    });

    // `Number('')` is zero, so a line that named no turn would otherwise offer the scope.
    it('offers nothing when what precedes the space is not a turn', () => {
      expect(typedRewindScope(REWIND, ' files')).toBeNull();
      expect(typedRewindScope(REWIND, 'x ')).toBeNull();
    });

    it('offers nothing for another command', () => {
      expect(typedRewindScope(TAG, '3 ')).toBeNull();
    });
  });

  describe('readRewindCommand', () => {
    it('finds the turn the number counts back to', () => {
      expect(readRewindCommand('1', points)?.point.eventId).toBe('e3');
      expect(readRewindCommand('3', points)?.point.eventId).toBe('e1');
    });

    it('takes the files when they were asked for', () => {
      expect(readRewindCommand('2 files', points)?.files).toBe(true);
    });

    /**
     * The conversation alone is the smaller of the two and the only one that cannot lose
     * work outside the session, so it is the safe reading of a line somebody cut short.
     */
    it.each([['2'], ['2 conversation'], ['2 something']])('leaves the files alone for %s', (input) => {
      expect(readRewindCommand(input, points)?.files).toBe(false);
    });

    // The menu is what a bare `/rewind` asks for, and it is already open.
    it('asks for nothing when no turn was named', () => {
      expect(readRewindCommand('', points)).toBeNull();
      expect(readRewindCommand('  ', points)).toBeNull();
    });

    it('asks for nothing when the turn is not one of them', () => {
      expect(readRewindCommand('9', points)).toBeNull();
      expect(readRewindCommand('0', points)).toBeNull();
    });

    it('asks for nothing when the turn is not a number', () => {
      expect(readRewindCommand('files', points)).toBeNull();
    });
  });
});
