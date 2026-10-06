import { countChanges, parsePatch } from './patch';
import { splitByFile } from '../../shared/patch';
import type { Entry } from './transcriptEntries';

/** One file a turn changed, and how much of it. */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  /**
   * Every edit made to it in this turn, in the order they were made.
   *
   * Kept apart rather than merged: the second edit's line numbers count a file the first
   * one already changed, so joining them would place its hunks wrong. Their count is also
   * how often the file was written.
   */
  patches: string[];
}

/** What a turn changed, taken together. */
export interface TurnChanges {
  /**
   * The turn itself, which is the question that began it.
   *
   * Stable as the turn goes on, where the row it is drawn under is not: a summary is keyed
   * to the last row of its turn, so every new row moves it. Whatever is remembered about
   * how it is being read has to hang on this instead.
   */
  id: string;
  files: ChangedFile[];
  added: number;
  removed: number;
}

/**
 * When a turn should say what it changed.
 *
 * `multiple` was the only behaviour at first, on the reasoning that a lone edit's own row
 * already names the file and opens onto the same diff. In use that reads as the summary
 * being broken rather than withheld, so the choice is the reader's (#40).
 */
export type ShowTurnChanges = 'off' | 'multiple' | 'always';

/**
 * What each turn changed, by the entry its turn ends on.
 *
 * A turn's edits are scattered through it, often with a long reply between them, so what a
 * turn came to is not readable from any one row. This gathers them where the turn ends,
 * which is where somebody looks to find out what happened (#40).
 *
 * Read from the rows already in hand rather than asked for: every edit carries the patch it
 * made, so the totals are a sum rather than a fetch. That also means a turn only partly
 * loaded is summarised from the part that is loaded - the alternative being to say nothing
 * until the whole of it has been read back, which for a long turn is most of a session.
 */
export function changesByTurn(entries: Entry[], show: ShowTurnChanges = 'always'): Map<number, TurnChanges> {
  const byTurn = new Map<number, TurnChanges>();
  if (show === 'off') return byTurn;

  /** How many real changes a turn needs before it is worth a line of its own. */
  const least = show === 'multiple' ? 2 : 1;

  let edits: Entry[] = [];
  let startedAt = -1;

  const close = (endsAt: number) => {
    // A cheap gate before parsing: a turn cannot end up with more changes than it made
    // calls, whatever the patches turn out to say.
    if (edits.length >= least) {
      const summary = gather(edits);
      // Counted after parsing, because a call that wrote a file without changing it is not
      // an edit, and a turn can be left with fewer real changes than it made calls.
      const made = summary.files.reduce((n, file) => n + file.patches.length, 0);
      if (made >= least) byTurn.set(endsAt, { ...summary, id: entries[startedAt]?.key ?? String(startedAt) });
    }
    edits = [];
  };

  for (const [index, entry] of entries.entries()) {
    // A question begins a turn, so it ends whatever came before it.
    if (entry.kind === 'message' && entry.variant === 'user') {
      if (startedAt >= 0) close(index - 1);
      // A page opens partway through a session, so anything above the first question belongs
      // to a turn whose beginning was never read. Summarising it would be summarising a
      // fragment, and attributing it to the turn below would be worse.
      else edits = [];
      startedAt = index;
      continue;
    }

    if (entry.kind === 'tool' && entry.patch) edits.push(entry);
  }

  // The turn in progress ends where the rows do.
  if (startedAt >= 0) close(entries.length - 1);

  return byTurn;
}

/** Fold a turn's edits into one file list, newest count last so a file appears once. */
function gather(edits: Entry[]): Omit<TurnChanges, 'id'> {
  const files = new Map<string, ChangedFile>();
  let added = 0;
  let removed = 0;

  for (const entry of edits) {
    if (entry.kind !== 'tool' || !entry.patch) continue;

    for (const file of filesIn(entry.patch, entry.path)) {
      const counts = countChanges(parsePatch(file.patch));
      // Writing a file without changing it leaves a patch of nothing but context. Counting
      // it would claim an edit that is not there and draw a diff with nothing in it.
      if (counts.added === 0 && counts.removed === 0) continue;

      added += counts.added;
      removed += counts.removed;

      const held = files.get(file.path);
      if (held) {
        held.added += counts.added;
        held.removed += counts.removed;
        held.patches.push(file.patch);
      } else {
        files.set(file.path, {
          path: file.path,
          added: counts.added,
          removed: counts.removed,
          patches: [file.patch],
        });
      }
    }
  }

  return { files: [...files.values()], added, removed };
}

/**
 * The files one edit was about, and the part of its patch belonging to each.
 *
 * Taken from the patch rather than from the row's own path, because a row has one path and
 * a patch may be about several files: `apply_patch` takes a whole envelope and carries no
 * path at all in its arguments. That is why the summary used to skip every patch it applied
 * - the row had a patch and no path, and the pair was required.
 *
 * The row's path still wins where the patch is about a single file. It is the path the tool
 * was given, in the platform's own spelling, where the patch holds git's normalised one.
 */
function filesIn(patch: string, path: string | undefined): { path: string; patch: string }[] {
  const inside = splitByFile(patch);
  if (inside.length === 1 && path) return [{ path, patch }];
  if (inside.length > 0) return inside;
  // A patch git did not write, so there are no headers to read. The row's own path is all
  // there is, and without one there is nothing to attribute the change to.
  return path ? [{ path, patch }] : [];
}
