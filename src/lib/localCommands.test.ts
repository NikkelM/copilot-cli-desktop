import { describe, expect, it } from 'vitest';

import { LOCAL_COMMANDS, isLocal, withLocalChoices } from './localCommands';
import type { SlashCommand } from '../../shared/protocol';

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
