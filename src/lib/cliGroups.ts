import type { CliSetting } from '../../shared/protocol';

/** Settings sharing a first segment, drawn together under it. */
export interface CliGroup {
  /** The shared segment, which is what the group is called. */
  prefix: string;
  settings: CliSetting[];
}

export type CliEntry = { kind: 'one'; setting: CliSetting } | { kind: 'group'; group: CliGroup };

/**
 * The CLI's settings, with the nested ones gathered under what they are nested in.
 *
 * The schema is flat and dotted - `sandbox.enabled`, `sandbox.auth.git`, and thirteen more -
 * which drew as fifteen rows of nearly the same name, and the sandbox is not even the
 * longest of them. Gathered, the category reads as a list of subjects, and the reader opens
 * the one they came for.
 *
 * Only two or more make a group. A single nested setting under a name of its own is a group
 * with nothing to choose inside it: a row that has to be opened to show one row.
 *
 * Grouped by the first segment rather than by every level. `sandbox.userPolicy.network.*`
 * could nest three deep, but nesting a window inside a window inside a list is harder to
 * read than one heading with the rest of the path written out under it.
 *
 * Order is the order they arrived in, with a group where its first member was, so the list
 * stays in whatever order the settings came in rather than being re-sorted on the way past.
 */
export function groupCliSettings(settings: readonly CliSetting[]): CliEntry[] {
  const groups = new Map<string, CliSetting[]>();
  for (const setting of settings) {
    const prefix = prefixOf(setting.path);
    if (prefix !== null) groups.set(prefix, [...(groups.get(prefix) ?? []), setting]);
  }

  const entries: CliEntry[] = [];
  const drawn = new Set<string>();

  for (const setting of settings) {
    const prefix = prefixOf(setting.path);
    const together = prefix === null ? undefined : groups.get(prefix);

    if (prefix === null || together === undefined || together.length < 2) {
      entries.push({ kind: 'one', setting });
      continue;
    }

    if (drawn.has(prefix)) continue;
    drawn.add(prefix);
    entries.push({ kind: 'group', group: { prefix, settings: together } });
  }

  return entries;
}

/** What a setting is nested in, or nothing for one that is nested in nothing. */
function prefixOf(path: string): string | null {
  const at = path.indexOf('.');
  return at > 0 ? path.slice(0, at) : null;
}

/**
 * What to call a setting inside its group.
 *
 * The prefix is already the heading above it, so repeating it on every row spends the width
 * that tells the rows apart. What is left still carries its own dots, which is the rest of
 * where it lives.
 */
export function leafName(path: string, prefix: string): string {
  return path.startsWith(`${prefix}.`) ? path.slice(prefix.length + 1) : path;
}
