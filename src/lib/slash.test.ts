import { describe, expect, it } from 'vitest';

import {
  commandText,
  completionOf,
  dispatch,
  findCommand,
  looksLikeCommand,
  matchCommands,
  typedCommand,
} from './slash';
import { HELP } from './localCommands';
import type { SlashCommand } from '../../shared/protocol';

function command(name: string, extra: Partial<SlashCommand> = {}): SlashCommand {
  return { name, description: `does ${name}`, aliases: [], allowDuringTurn: true, ...extra };
}

const COMMANDS = [
  command('model', { aliases: ['models'], hint: 'model' }),
  command('memory', { hint: '' }),
  command('allow-all', { aliases: ['yolo'], hint: '[on|off|show]' }),
  command('compact', { hint: 'focus instructions', allowDuringTurn: false }),
  command('usage'),
];

describe('typedCommand', () => {
  it('reads a bare slash as a command with no name yet', () => {
    expect(typedCommand('/')).toEqual({ name: '', input: null });
  });

  it('separates the name from what follows the first space', () => {
    expect(typedCommand('/model gpt-5 fast')).toEqual({ name: 'model', input: 'gpt-5 fast' });
  });

  it('reports an empty argument once the space is typed', () => {
    expect(typedCommand('/model ')).toEqual({ name: 'model', input: '' });
  });

  it('is not a command without a leading slash', () => {
    expect(typedCommand('tell me about /model')).toBeNull();
  });

  // The whole reason a path is safe: it parses, matches nothing, and is therefore sent.
  it('parses a unix path, which then matches no command', () => {
    const typed = typedCommand('/usr/bin/env python');
    expect(typed).toEqual({ name: 'usr/bin/env', input: 'python' });
    expect(findCommand(COMMANDS, typed!.name)).toBeUndefined();
  });

  it('is not a command once it spans more than one line', () => {
    expect(typedCommand('/model\nand another thing')).toBeNull();
  });
});

// What separates a command nobody has heard of, which is worth an error, from text that
// happens to start with a slash, which is worth sending.
describe('looksLikeCommand', () => {
  it('accepts the shapes the runtime names its commands', () => {
    for (const name of ['help', 'allow-all', 'model', 'security-review', 'a', 'b2']) {
      expect(looksLikeCommand(name), name).toBe(true);
    }
  });

  it('rejects a path, which is text and has to stay text', () => {
    expect(looksLikeCommand('usr/bin/env')).toBe(false);
    expect(looksLikeCommand('home/nikke')).toBe(false);
  });

  it('rejects a bare slash, a fraction and a sentence', () => {
    expect(looksLikeCommand('')).toBe(false);
    expect(looksLikeCommand('2')).toBe(false);
    expect(looksLikeCommand('not.a.command')).toBe(false);
  });
});

describe('matchCommands', () => {
  it('offers everything for a bare slash', () => {
    expect(matchCommands(COMMANDS, '')).toHaveLength(COMMANDS.length);
  });

  it('puts what is being typed the start of first', () => {
    // compact only contains an m, so it comes after the two that begin with one.
    expect(matchCommands(COMMANDS, 'm').map((c) => c.name)).toEqual(['model', 'memory', 'compact']);
  });

  it('finds a command by an alias', () => {
    expect(matchCommands(COMMANDS, 'yol').map((c) => c.name)).toEqual(['allow-all']);
  });

  // Three bands, in order: name, then alias, then merely containing.
  it('ranks a name before an alias before a substring', () => {
    const commands = [
      command('elsewhere'), // contains "all" nowhere, so must not appear
      command('recall'), // contains it
      command('allocate', { aliases: ['x'] }), // starts with it
      command('permissions', { aliases: ['allow'] }), // alias starts with it
    ];
    expect(matchCommands(commands, 'all').map((c) => c.name)).toEqual([
      'allocate',
      'permissions',
      'recall',
    ]);
  });

  it('ignores case', () => {
    expect(matchCommands(COMMANDS, 'MOD').map((c) => c.name)).toEqual(['model']);
  });
});

describe('findCommand', () => {
  it('matches the canonical name', () => {
    expect(findCommand(COMMANDS, 'usage')?.name).toBe('usage');
  });

  it('matches an alias', () => {
    expect(findCommand(COMMANDS, 'yolo')?.name).toBe('allow-all');
  });

  it('does not match a prefix, which is not the same command', () => {
    expect(findCommand(COMMANDS, 'us')).toBeUndefined();
  });
});

describe('completionOf', () => {
  it('offers the rest of the name', () => {
    expect(completionOf('mod', COMMANDS[0])).toBe('el');
  });

  // Completing an alias would replace what was typed with a different spelling, which
  // reads as the box correcting you rather than finishing your word.
  it('offers nothing when the match came from an alias', () => {
    expect(completionOf('yol', COMMANDS[2])).toBe('');
  });

  it('offers nothing for a bare slash, where every command is still possible', () => {
    expect(completionOf('', COMMANDS[0])).toBe('');
  });
});

describe('commandText', () => {
  it('leaves the cursor after a space for a command that takes an argument', () => {
    expect(commandText(COMMANDS[0]!)).toBe('/model ');
  });

  it('adds no space to a command that takes nothing', () => {
    expect(commandText(COMMANDS[4]!)).toBe('/usage');
  });
});

describe('dispatch', () => {
  it('runs a command the runtime owns, with whatever followed it', () => {
    expect(dispatch('/compact only the tests', COMMANDS)).toEqual({
      kind: 'command',
      command: COMMANDS[3],
      input: 'only the tests',
    });
  });

  it('runs a command with no argument as a command with an empty one', () => {
    expect(dispatch('/usage', COMMANDS)).toEqual({ kind: 'command', command: COMMANDS[4], input: '' });
  });

  it('finds a command under an alias', () => {
    expect(dispatch('/yolo on', COMMANDS)).toEqual({ kind: 'command', command: COMMANDS[2], input: 'on' });
  });

  // Answered here, so it needs no session and never reaches the runtime that has not heard
  // of it.
  it('separates the commands this app answers itself', () => {
    const what = dispatch('/help', [...COMMANDS, HELP]);

    expect(what).toEqual({ kind: 'local', command: HELP, input: '' });
  });

  it('sends anything without a leading slash as text', () => {
    expect(dispatch('what does /model do?', COMMANDS)).toEqual({ kind: 'text' });
  });

  // A slash alone does not make a command, or a pasted path would become one.
  it('sends a path as text', () => {
    expect(dispatch('/usr/bin/env python', COMMANDS)).toEqual({ kind: 'text' });
  });

  it('sends a fraction as text', () => {
    expect(dispatch('/2 of the way there', COMMANDS)).toEqual({ kind: 'text' });
  });

  it('sends a bare slash as text', () => {
    expect(dispatch('/', COMMANDS)).toEqual({ kind: 'text' });
  });

  /**
   * The bug this exists for: forty of the CLI's commands are drawn by the terminal and
   * unknown to the runtime, so they used to fall past the lookup and reach the agent as a
   * message - spending a turn on a word never meant for it.
   */
  describe('a command nobody has heard of', () => {
    it('is named rather than sent', () => {
      const what = dispatch('/chronicle', COMMANDS);

      expect(what.kind).toBe('unknown');
      expect(what).toMatchObject({ name: 'chronicle' });
    });

    it('offers what it might have meant', () => {
      const what = dispatch('/mode', COMMANDS);

      expect(what).toMatchObject({ kind: 'unknown', near: [COMMANDS[0]] });
    });

    it('offers no more than three', () => {
      const what = dispatch('/m', COMMANDS);

      expect(what.kind === 'unknown' && what.near.length).toBeLessThanOrEqual(3);
    });

    // Nothing can be said to be unknown against a list that has not arrived, and a message
    // is the one outcome that is never wrong to fall back to.
    it('is sent as text while there is no list to check against', () => {
      expect(dispatch('/chronicle', [])).toEqual({ kind: 'text' });
    });
  });
});
