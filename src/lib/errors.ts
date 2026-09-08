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
