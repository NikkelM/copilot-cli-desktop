/**
 * A unified diff, reduced to what a viewer needs to draw it.
 *
 * Git's output carries a header describing how it arrived at the patch - index hashes,
 * modes, the two paths - which repeats what the surrounding row already says. Only the
 * hunks are kept, and each line is labelled by what it means rather than by its first
 * character, so the view is not re-reading punctuation.
 */
export type PatchLineKind = 'added' | 'removed' | 'context' | 'hunk';

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
  /** Line number in the file before the change, absent for added lines. */
  before: number | null;
  /** Line number in the file after the change, absent for removed lines. */
  after: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw, before: null, after: null });
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

  return lines;
}

/** How much a patch adds and removes, for saying so without reading it. */
export function countChanges(lines: PatchLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length,
  };
}
