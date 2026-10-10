/**
 * Naming a file in a message with `@` (#135).
 *
 * The CLI offers this and the app offered nothing, so the only way to point an agent at a
 * file was to type its path out. What goes into the message is the path rather than an
 * attachment: the agent reads the file when it gets there, which costs nothing until it is
 * needed, where attaching sends the contents whether they are wanted or not.
 *
 * The `@` is how this app is asked for the menu and nothing more. It does not survive into
 * the message, because the agent does not read it: a path is something it can resolve, and
 * a marker in front of one is something it has to guess at.
 */

/** Where a mention being written starts, and how much of the path has been typed. */
export interface Mention {
  /** Where the `@` is, so what replaces the mention knows what to cut. */
  at: number;
  /** The path so far, which may be empty when only the `@` has been typed. */
  path: string;
}

/**
 * What stops a mention.
 *
 * A space ends one, which is what makes `@src/App.tsx and @other.ts` two mentions rather
 * than one long one. Quotes and brackets end one too, so a path written inside them is not
 * swallowed along with what encloses it.
 */
const ENDS = /[\s"'`()[\]{}<>,;]/;

/**
 * The mention the caret is in, if it is in one.
 *
 * Read backwards from the caret rather than by scanning the text, because what matters is
 * the word being written now: an `@` earlier in a finished sentence is not being completed
 * and a menu over it would be answering a question nobody asked.
 *
 * An `@` with a word in front of it is not a mention. That is an email address, a handle, or
 * the middle of something, and none of them wants a file menu.
 */
export function typedMention(value: string, caret: number): Mention | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));

  for (let at = before.length - 1; at >= 0; at -= 1) {
    const character = before[at]!;
    if (character === '@') {
      const leading = at === 0 ? '' : before[at - 1]!;
      if (leading !== '' && !ENDS.test(leading)) return null;
      return { at, path: before.slice(at + 1) };
    }
    // Anything that ends a mention, reached before an `@`, means the caret is not in one.
    if (ENDS.test(character)) return null;
  }

  return null;
}

/**
 * The message with the mention replaced by a path.
 *
 * The marker goes once a file is chosen. `@` is how this app was asked for the menu, not
 * something the agent reads: a message carrying `@../Music/readme.txt` was answered by
 * looking in the wrong place entirely, because what reached the agent was a token it had to
 * guess at rather than a path it could resolve. What is left is a plain path.
 *
 * It stays while a folder is being walked, because that is the half-written state the menu
 * reads to know it is still wanted - strip it there and the menu closes on the way into the
 * very folder it was opened to reach.
 *
 * A trailing space follows a finished file so the next word does not run into it, and a
 * folder is left without one because the reader is still typing.
 */
export function withMention(
  value: string,
  mention: Mention,
  path: string,
  caret: number,
  finished = true,
): { value: string; caret: number } {
  // What the mention covers is everything from the `@` to the caret, which is exactly what
  // was read to find it. Anything past the caret was written before and is left alone.
  const rest = value.slice(Math.max(mention.at, Math.min(caret, value.length)));
  const written = finished ? `${path} ` : `@${path}`;

  return { value: `${value.slice(0, mention.at)}${written}${rest}`, caret: mention.at + written.length };
}
