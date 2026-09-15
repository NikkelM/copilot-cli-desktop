import { describe, expect, it } from 'vitest';

import { explain, messageOf } from './errors';

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

/**
 * Every message asserted here was taken from the strings in the runtime binary, so these
 * are the wordings the app will actually be handed rather than plausible ones.
 */
describe('explain', () => {
  it('says a session has no history rather than naming the first event it wanted', () => {
    const raw = 'Request session.resume failed with message: session resume failed: First event must be session.start or session.resume';

    expect(explain(raw)).toBe(
      'This session has no history left to reopen. Its record in the session store is empty or was removed.',
    );
  });

  it('treats an empty event array as the same thing, because it is', () => {
    expect(explain('Cannot create session from empty events array')).toBe(explain('First event must be session.start'));
  });

  it('separates damaged history from missing history', () => {
    expect(explain('Session file is corrupted (line 12)')).toBe(
      'The history for this session is damaged and cannot be replayed.',
    );
    expect(explain('Failed to load session events: Session not found: abc123')).toBe(
      'This session is no longer in the session store, so there is nothing to reopen.',
    );
  });

  it('says the working directory is gone', () => {
    expect(explain('working directory not found')).toBe(
      'The working directory for this session no longer exists, so it cannot be opened there.',
    );
  });

  it('says how to sign in rather than that authentication failed', () => {
    const signIn = 'Copilot is not signed in. Sign in with the copilot command in a terminal, then try again.';

    expect(explain('SDK session authentication failed: token expired')).toBe(signIn);
    expect(explain('Sign in to GitHub Copilot')).toBe(signIn);
  });

  it('says the CLI could not be started when that is what happened', () => {
    expect(explain("Error: spawn copilot ENOENT")).toBe(
      'The Copilot CLI could not be started. Check that it is installed and on PATH.',
    );
  });

  /**
   * The whole point of the fallback: an error nobody anticipated is the only evidence there
   * is, and a guess in its place would send the reader after the wrong problem.
   */
  it('leaves anything it does not recognise exactly as it arrived, wrapper aside', () => {
    const raw = 'Request session.model.set failed with message: no such model';

    expect(explain(raw)).toBe('no such model');
  });

  /** A missing file that is not the CLI is described by its path, which explain would lose. */
  it('does not mistake every missing file for a missing Copilot', () => {
    const raw = "ENOENT: no such file or directory, open 'C:\\notes\\todo.md'";

    expect(explain(raw)).toBe(raw);
  });

  /**
   * The failure that never means what it says (#169). `Unknown method` is the sidecar
   * reporting the frontend asked for something it has never heard of, which is always a
   * build older than the window and never a fault in the feature it names.
   */
  describe('a method the runtime has never heard of', () => {
    it('blames the build rather than the feature, and keeps the name', () => {
      const raw = 'Request sidecar failed with message: Unknown method: sessions.setMode';

      expect(explain(raw)).toBe(
        'The runtime does not know sessions.setMode, which means it was built before this window. Restart the app.',
      );
    });

    it('names whichever method it was', () => {
      expect(explain('Unknown method: filesystem.directories')).toContain('filesystem.directories');
    });

    /** The message arrives from the sidecar's own log line, which is not capitalised. */
    it('reads it however the sidecar spelt it', () => {
      expect(explain('unknown method: sessions.mode')).toContain('sessions.mode');
    });

    // The agent discussing one is not the app failing to call one.
    it('leaves a sentence that merely mentions the words alone', () => {
      const raw = 'The unknown method of doing this is worse';

      expect(explain(raw)).toBe(raw);
    });
  });
});
