/**
 * The one spelling of a tag, for sessions and for wiki pages alike (#35).
 *
 * Both halves of the app ask the same question of a tag - is this the same word as that one -
 * and they have to answer it identically or a session tagged `Timeless Manor` never finds a
 * page tagged `timeless-manor`. So the answer is written once, here, where the frontend and
 * the sidecar can both reach it.
 *
 * Dashes rather than spaces, which is what a wiki writes. Sessions kept their spaces for a
 * while on the grounds that a tag is a label rather than an identifier; that was true in
 * isolation and wrong as soon as the two had to match each other.
 *
 * Anything that is not a letter or a digit becomes a single dash, so `needs review`,
 * `Needs-Review` and `needs  review!` are one tag. A string with nothing else in it comes
 * back empty, which is how callers tell a tag from a keypress.
 */
export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
