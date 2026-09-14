import { describe, expect, it } from 'vitest';

import { BROWSE, LOCAL_COMMANDS, isLocal, wantsDirectory, withLocalChoices } from './localCommands';
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

/**
 * A directory is the one argument a window supplies better than a keyboard, so the commands
 * that want one are answered with a picker. Verified against the runtime rather than
 * assumed: `/add-dir` with nothing after it fails with a usage line, while `/cwd` with
 * nothing after it reports where the session is.
 */
describe('wantsDirectory', () => {
  it.each(['add-dir', 'cwd'])('offers the picker when %s is asked for it by name', (name) => {
    expect(wantsDirectory(name, BROWSE)).toBe(true);
  });

  /** Typed rather than chosen from the menu, which is the same request spelt by hand. */
  it('ignores the case it was typed in', () => {
    expect(wantsDirectory('add-dir', 'Browse')).toBe(true);
    expect(wantsDirectory('add-dir', '  browse  ')).toBe(true);
  });

  /** Nothing is lost: the runtime answers a bare /add-dir with a usage line and no more. */
  it('offers the picker for a bare /add-dir, which would otherwise only fail', () => {
    expect(wantsDirectory('add-dir', '')).toBe(true);
    expect(wantsDirectory('add-dir', '   ')).toBe(true);
  });

  /**
   * The one case that must not be taken. A bare /cwd reports the current directory, which
   * is useful and is not ours to replace with a window nobody asked for.
   */
  it('leaves a bare /cwd alone, because it already answers', () => {
    expect(wantsDirectory('cwd', '')).toBe(false);
  });

  it('leaves a path that was actually typed alone', () => {
    expect(wantsDirectory('add-dir', 'C:\\work\\repo')).toBe(false);
    expect(wantsDirectory('cwd', '/home/user/projects')).toBe(false);
  });

  it('has nothing to say about commands that do not want a directory', () => {
    expect(wantsDirectory('model', BROWSE)).toBe(false);
    expect(wantsDirectory('session', '')).toBe(false);
  });
});

/** The word has to appear in the menu, or the only way to find it is to already know. */
describe('the browse choice', () => {
  it.each(['add-dir', 'cwd'])('is offered on %s', (name) => {
    const [found] = withLocalChoices([command({ name })]);
    expect(found!.choices?.map((c) => c.name)).toContain(BROWSE);
  });

  it('is not offered on commands that take no directory', () => {
    const [model] = withLocalChoices([command({ name: 'model' })]);
    expect(model!.choices?.map((c) => c.name) ?? []).not.toContain(BROWSE);
  });
});