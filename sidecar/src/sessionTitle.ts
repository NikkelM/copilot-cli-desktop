/**
 * Giving a new session a title worth reading.
 *
 * The runtime names a session it has just been handed a prompt with that prompt, verbatim
 * and entire. The CLI replaces that with a written title; a session opened through the SDK
 * keeps the prompt, and keeps it forever - every session this app has ever made still has
 * `summary_count: 0`. One of them was 303 characters, which filled thirteen lines of the
 * sidebar (#197).
 *
 * There is no call that writes a title. What exists is a way to ask the session's own model
 * a question about its conversation, and a way to set a name that is not somebody's choice.
 * This module holds the parts of that with no runtime in them.
 */

/**
 * What to ask for, in the runtime's own words.
 *
 * Copied out of `runtime.node`, where the CLI's titles come from, rather than written here:
 * a session titled by this app should be indistinguishable from one titled by the CLI, and
 * the only way to be sure of that is to ask the same question.
 */
export const TITLE_QUESTION = `Generate a short title for a coding session based on the user's message.

Rules:
- 2-6 words, title case
- Focus on the task, not conversational aspects
- No quotes, no punctuation at start/end
- Output the title inside <session-title></session-title> tags`;

/** Longest a written title should be. Past this the model has answered with something else. */
const MAX_TITLE = 60;

/**
 * The title out of the model's answer, or nothing if it did not give one.
 *
 * The tags are asked for so the answer can be found in a reply that also explains itself.
 * Anything without them is not refused on a guess at what it meant: a model that ignored
 * the format has probably ignored the rest of it too, and a bad title is worse than the
 * prompt it would replace, which at least says what the session is about.
 */
export function titleIn(answer: string): string | null {
  const tagged = /<session-title>([\s\S]*?)<\/session-title>/i.exec(answer)?.[1];
  if (tagged === undefined) return null;

  const title = tagged.replace(/\s+/g, ' ').trim();
  if (!title || title.length > MAX_TITLE) return null;

  return title;
}

/**
 * Whether a session's name is the prompt standing in for a title.
 *
 * Exact rather than a guess at length: the runtime writes the prompt verbatim, so a name
 * that is the prompt is a placeholder and a name that is not is something else - a title
 * the CLI wrote, or one somebody typed. A session with no name at all has never been given
 * one, which counts the same.
 *
 * `named` is the session's own record of whether the name was chosen deliberately, and
 * outranks everything: a name somebody typed is never replaced, whatever it says.
 */
export function isPlaceholder(name: string | null, prompt: string, named: boolean): boolean {
  if (named) return false;
  if (name === null || name.trim() === '') return true;

  return name.trim() === prompt.trim();
}
