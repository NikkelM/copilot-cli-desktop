/**
 * Put text on the clipboard, and say whether it worked.
 *
 * One place rather than one per caller: the same id is copied from a slash command and
 * from the sidebar (#126/#129), and saying nothing on failure would look exactly like
 * succeeding - the one outcome worse than failing.
 */
export function copyText(text: string): Promise<boolean> {
  return navigator.clipboard
    .writeText(text)
    .then(() => true)
    .catch(() => false);
}
