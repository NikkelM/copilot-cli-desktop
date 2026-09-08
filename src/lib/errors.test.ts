import { describe, expect, it } from 'vitest';

import { messageOf } from './errors';

describe('messageOf', () => {
  /** What the runtime answers when a command is missing an argument it requires. */
  it('drops the name of the call that carried the message', () => {
    const usage = 'Usage: /add-dir <directory>\nExample: /add-dir /home/user/projects';

    expect(messageOf(`Request session.commands.invoke failed with message: ${usage}`)).toBe(usage);
  });

  it('reads an Error as well as a plain string', () => {
    expect(messageOf(new Error('Request session.commands.invoke failed with message: nope'))).toBe('nope');
  });

  it('takes the wrapper off an Error that also carries its class name', () => {
    expect(messageOf('Error: Request session.model.set failed with message: no such model')).toBe('no such model');
  });

  it('leaves an unrecognised message as it is', () => {
    expect(messageOf('The sidecar is not running')).toBe('The sidecar is not running');
  });

  /** Shortening on a guess is how the part that mattered gets lost. */
  it('does not go looking for the wrapper in the middle of a message', () => {
    const text = 'The agent said: Request session.commands.invoke failed with message: x';

    expect(messageOf(text)).toBe(text);
  });

  it('keeps something to show when the wrapper is all there was', () => {
    const only = 'Request session.commands.invoke failed with message: ';

    expect(messageOf(only)).toBe(only.trim());
  });

  it('says something for a thrown value that is not an error at all', () => {
    expect(messageOf(null)).toBe('null');
    expect(messageOf({ code: 1 })).toBe('[object Object]');
  });
});
