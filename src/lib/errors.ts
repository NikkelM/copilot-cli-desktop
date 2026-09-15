/**
 * What an error has to say, without the machinery it travelled through.
 *
 * The runtime writes its refusals for a reader: asking for `/add-dir` with no argument
 * answers with its usage and an example, which is better than anything this app could say
 * without restating the command's own documentation. What arrives here is that text wrapped
 * in the name of the call that carried it, which means nothing to anyone who did not write
 * this app, and which pushes the useful half off the end of a one-line row.
 *
 * Only the wrapper this app's own transport adds is removed. Anything else is left alone:
 * an error whose wording is not recognised is still the best account there is of what went
 * wrong, and shortening it on a guess would lose the part that mattered.
 */
export function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const bare = text.replace(/^(?:Error:\s*)?Request \S+ failed with message:\s*/, '').trim();
  return bare || text.trim() || String(error);
}

/**
 * The handful of failures that have a plain meaning, said plainly.
 *
 * The runtime answers in its own terms, which are about its wire protocol and its store
 * rather than about what happened. "First event must be session.start or session.resume"
 * means the session's history is gone; nobody reading it would know that, and it does not
 * suggest the one thing worth doing about it.
 *
 * Every pattern here was taken from the strings in the runtime binary rather than guessed
 * at, because a wrong translation is worse than a technical sentence: it sends the reader
 * after the wrong problem, and unlike the raw text it cannot be searched for.
 */
const PLAINLY: Array<{ when: RegExp; say: string | ((match: RegExpMatchArray) => string) }> = [
  /**
   * The one error that is never about the feature it names (#169).
   *
   * The three pieces of this app ship separately, so either half can be older than the
   * other with nothing to say so. What that looks like is a method the running sidecar has
   * never heard of, which reads as a broken feature and sends the reader into its source,
   * where the handler is plainly registered and plainly correct.
   *
   * The name is kept, because it is still the quickest way to see which change went
   * missing; only the conclusion is supplied.
   */
  {
    when: /unknown method:\s*(\S+)/i,
    say: (match) =>
      `The runtime does not know ${match[1]}, which means it was built before this window. Restart the app.`,
  },
  {
    when: /first event must be session\.(start|resume)|cannot create session from empty events array/i,
    say: 'This session has no history left to reopen. Its record in the session store is empty or was removed.',
  },
  {
    when: /session file is corrupted|failed to parse resume replay events/i,
    say: 'The history for this session is damaged and cannot be replayed.',
  },
  {
    when: /session not found|failed to (load|read) session events/i,
    say: 'This session is no longer in the session store, so there is nothing to reopen.',
  },
  {
    when: /working directory not found|unable to read current working directory/i,
    say: 'The working directory for this session no longer exists, so it cannot be opened there.',
  },
  {
    when: /authentication (failed|required)|sign(ed)? in to (use )?github copilot|not signed in/i,
    say: 'Copilot is not signed in. Sign in with the copilot command in a terminal, then try again.',
  },
  {
    when: /enoent[^]*copilot(\.exe)?['"\s]|spawn copilot/i,
    say: 'The Copilot CLI could not be started. Check that it is installed and on PATH.',
  },
];

/**
 * What went wrong, in words, with the technical account kept where it is still the best one.
 *
 * Anything unrecognised is returned as it arrived: an error nobody anticipated is still the
 * only real evidence of what happened, and replacing it with a guess would lose the part
 * that mattered.
 */
export function explain(error: unknown): string {
  const message = messageOf(error);
  const found = PLAINLY.find(({ when }) => when.test(message));
  if (!found) return message;

  return typeof found.say === 'string' ? found.say : found.say(message.match(found.when)!);
}
