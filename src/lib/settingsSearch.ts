/**
 * Finding a setting without knowing which category it is in.
 *
 * The window has five categories and the Copilot CLI one alone holds seventy-odd settings
 * drawn from the CLI's own schema, so knowing where something lives is no longer something
 * a reader can be assumed to know (#204).
 *
 * The sidebar and the settings inside a category are filtered by the same rule, because
 * they have to agree: a category listed as having a match, opened to nothing, is worse than
 * one that was never listed.
 */

/** What a setting can be found by. The same shape whether it is written here or read from the CLI. */
export interface Searchable {
  /** What the window calls it, which is what somebody looking at it would type. */
  label: string;
  /** What it is about, in words the label does not contain. */
  keywords?: string;
  /** What it can be set to, where that is a known set - so `prerelease` finds the channel. */
  options?: readonly string[];
}

/**
 * Whether a setting answers what was typed.
 *
 * Every word has to appear somewhere, rather than the whole query appearing as typed:
 * "deleted keep" and "keep deleted" both find "Keep a deleted session for", and nobody
 * types a setting's name in the order it happens to be written.
 *
 * An empty query matches everything, which is what a reader who has typed nothing means.
 */
export function matches(query: string, entry: Searchable): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const haystack = [entry.label, entry.keywords ?? '', ...(entry.options ?? [])].join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Whether a category holds anything worth opening it for. */
export function anyMatch(query: string, entries: readonly Searchable[]): boolean {
  return entries.some((entry) => matches(query, entry));
}
