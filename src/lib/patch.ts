/**
 * A unified diff, reduced to what a viewer needs to draw it.
 *
 * Git's output carries a header describing how it arrived at the patch - index hashes,
 * modes, the two paths - which repeats what the surrounding row already says. Only the
 * hunks are kept, and each line is labelled by what it means rather than by its first
 * character, so the view is not re-reading punctuation.
 */
export type PatchLineKind = 'added' | 'removed' | 'context' | 'skip';

/**
 * Every edit a turn made to one file, as a single diff.
 *
 * The edits cannot simply be laid end to end. Each one carries its own context, and
 * successive edits to the same part of a file overlap almost entirely: five appends to the
 * end of a file drew five near-identical blocks, each repeating the lines above it.
 *
 * Nor can their hunks be interleaved by line number, because each edit numbers the file as
 * the edit before it left it. What they do share is the lines themselves, so the join is
 * made on those: where an edit opens with lines already drawn, it continues them rather
 * than restating them.
 *
 * A line one edit added and the next treats as context keeps the mark the first edit gave
 * it. It was added by this turn, whatever the later edit thought it was looking at.
 */
export function mergeEdits(patches: string[]): PatchLine[] {
  const out: PatchLine[] = [];

  for (const patch of patches) {
    const lines = parsePatch(patch);
    if (lines.length === 0) continue;

    if (out.length === 0) {
      out.push(...lines);
      continue;
    }

    const shared = overlap(out, lines);
    const rest = lines.slice(shared);
    // Wholly inside what is already drawn, which is an edit that was undone by a later one.
    if (rest.length === 0) continue;

    // Nothing in common, so this edit is somewhere else in the file. A gap says the line
    // numbers do not carry on, which is the same thing it says inside one patch.
    if (shared === 0) out.push({ kind: 'skip', text: '', before: null, after: null });
    out.push(...rest);
  }

  return out;
}

/**
 * How many of an edit's opening lines are already drawn at the end of what came before.
 *
 * Matched on the text rather than on the numbers: the numbers are what cannot be compared
 * across edits. The longest run wins, so a file whose lines repeat is joined at the furthest
 * point the two actually agree.
 */
function overlap(drawn: PatchLine[], lines: PatchLine[]): number {
  // A gap is a hole in the file rather than a line of it, so it can match nothing.
  const tail = drawn.filter((line) => line.kind !== 'skip');
  const most = Math.min(tail.length, lines.length);

  for (let size = most; size > 0; size -= 1) {
    const before = tail.slice(tail.length - size);
    if (lines.slice(0, size).every((line, at) => line.kind !== 'skip' && line.text === before[at]!.text)) return size;
  }

  return 0;
}

/**
 * Part of a line, marked when it is the part that actually changed.
 *
 * A line reported as changed is usually mostly unchanged - a renamed variable, a different
 * argument - and colouring all of it says only that something happened somewhere in it.
 */
export interface PatchSegment {
  text: string;
  changed: boolean;
}

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
  /** Line number in the file before the change, absent for added lines. */
  before: number | null;
  /** Line number in the file after the change, absent for removed lines. */
  after: number | null;
  /** Split where part of the line changed. Absent when all of it did, or none of it. */
  segments?: PatchSegment[];
  /** How many lines a gap stands for. */
  hidden?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** How many unchanged lines in a row are worth showing before they become a gap. */
const CONTEXT_LIMIT = 8;
/** How many to keep either side of that gap, so a change keeps its surroundings. */
const CONTEXT_KEPT = 3;

export function parsePatch(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let before = 0;
  let after = 0;
  let inHunk = false;

  for (const raw of patch.split('\n')) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      // A hunk boundary is a gap in the file, which is what a skip says.
      if (inHunk) lines.push({ kind: 'skip', text: '', before: null, after: null });
      inHunk = true;
      continue;
    }

    // Everything before the first hunk is git explaining itself, not the change.
    if (!inHunk) continue;

    // "\ No newline at end of file" belongs to the line above rather than being one.
    if (raw.startsWith('\\')) continue;

    if (raw.startsWith('+')) {
      lines.push({ kind: 'added', text: raw.slice(1), before: null, after: after++ });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'removed', text: raw.slice(1), before: before++, after: null });
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1), before: before++, after: after++ });
    }
    // A blank trailing line is an artefact of splitting, not part of the patch.
  }

  return collapse(markWithinLines(withoutPhantomLine(lines)));
}

/**
 * Drop the empty context line the CLI's patches end with.
 *
 * A file ending in a newline splits into one more piece than it has lines, and the CLI's
 * patch generator keeps that empty piece: editing a two-line file produces
 * `@@ -1,2 +1,3 @@` and a final context line containing nothing. Rendered faithfully, that
 * showed a third line in a file that has two.
 *
 * Only the very last line, and only when it is empty context. A file that genuinely ends in
 * a blank line produces two of them, and the real one must survive.
 */
function withoutPhantomLine(lines: PatchLine[]): PatchLine[] {
  const last = lines[lines.length - 1];
  if (last?.kind === 'context' && last.text === '') return lines.slice(0, -1);
  return lines;
}

/**
 * Mark the part of each changed line that differs from the line it replaced.
 *
 * Lines are paired by their position within a run: the first removed with the first added,
 * and so on. That is what a reader assumes when a block is rewritten, and where it is
 * wrong - a line inserted into the middle - the pairing finds nothing in common and the
 * whole line stays marked, which is the honest answer.
 */
function markWithinLines(lines: PatchLine[]): PatchLine[] {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.kind !== 'removed') continue;

    const removed: PatchLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'removed') removed.push(lines[i++]!);

    const added: PatchLine[] = [];
    let j = i;
    while (j < lines.length && lines[j]!.kind === 'added') added.push(lines[j++]!);

    for (let k = 0; k < Math.min(removed.length, added.length); k += 1) {
      const pair = splitCommon(removed[k]!.text, added[k]!.text);
      if (!pair) continue;
      removed[k]!.segments = pair.before;
      added[k]!.segments = pair.after;
    }

    i = j - 1;
  }

  return lines;
}

/**
 * Split two lines into what they share and what they do not.
 *
 * Common prefix and suffix rather than a word-level diff: a few lines instead of an
 * algorithm, and it finds the cases that matter - a changed argument, a renamed
 * identifier, altered indentation.
 */
function splitCommon(before: string, after: string): { before: PatchSegment[]; after: PatchSegment[] } | null {
  if (before === after) return null;

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;

  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  // Nothing in common, so marking part of it would say less than marking none.
  if (start === 0 && end === 0) return null;

  const split = (line: string): PatchSegment[] =>
    [
      { text: line.slice(0, start), changed: false },
      { text: line.slice(start, line.length - end), changed: true },
      { text: line.slice(line.length - end), changed: false },
    ].filter((segment) => segment.text !== '');

  return { before: split(before), after: split(after) };
}

/**
 * Replace long runs of unchanged lines with a gap.
 *
 * A patch generated with generous context can carry dozens of untouched lines between two
 * changes, and scrolling past them to reach the next one is the thing a diff exists to
 * save you from.
 */
function collapse(lines: PatchLine[]): PatchLine[] {
  const out: PatchLine[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.kind !== 'context') {
      out.push(lines[i]!);
      continue;
    }

    const run: PatchLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'context') run.push(lines[i++]!);
    const atEnd = i >= lines.length;
    i -= 1;

    if (run.length <= CONTEXT_LIMIT) {
      out.push(...run);
      continue;
    }

    // A run at either end of the patch has nothing on that side to keep company with.
    const head = out.length > 0 ? CONTEXT_KEPT : 0;
    const tail = atEnd ? 0 : CONTEXT_KEPT;

    out.push(...run.slice(0, head));
    out.push({ kind: 'skip', text: '', before: null, after: null, hidden: run.length - head - tail });
    if (tail > 0) out.push(...run.slice(run.length - tail));
  }

  return out;
}

/** How much a patch adds and removes, for saying so without reading it. */
export function countChanges(lines: PatchLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length,
  };
}
