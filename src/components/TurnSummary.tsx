import { ChevronIcon } from './Icons';
import { Diff } from './Diff';
import { fileBadge } from '../lib/fileBadge';
import { parsePatch, type PatchLine } from '../lib/patch';
import type { ChangedFile, TurnChanges } from '../lib/turnChanges';

/** How the reader has this summary open, if at all. */
export interface TurnView {
  open: boolean;
  /** Which file is open inside it. Undefined until they pick, which is what lets one open itself. */
  picked?: string | null;
}

/** The file's own name, which is what a reader recognises, with the rest of the path after it. */
function nameOf(path: string): { name: string; within: string } {
  const parts = path.split(/[\\/]/);
  const name = parts.pop() ?? path;
  return { name, within: parts.join('/') };
}

/**
 * What a turn changed, gathered where the turn ends.
 *
 * A turn's edits are scattered through it, often with a long reply between them, so what a
 * turn came to is not readable from any one row. This is where somebody looks to find out
 * what happened, which is why it sits at the end rather than beside the first edit (#40).
 *
 * Closed to a line. Open, it is the files and what each of them came to, and any of those
 * opens again onto the change itself - drawn by the same component the session's list of
 * changes uses, so the two never answer the same question differently (#40).
 */
export function TurnSummary({
  changes,
  view,
  onView,
}: {
  changes: TurnChanges;
  /**
   * How it is being read, held by whoever draws it rather than here (#140 follow-up).
   *
   * A summary is keyed to the last row of its turn, so every row the turn adds moves it to
   * a different place in the list and React builds it again. State kept in here went with
   * it, and a summary somebody had opened closed itself every time the agent did anything.
   */
  view: TurnView;
  onView: (view: TurnView) => void;
}) {
  const { open, picked } = view;
  const { files, added, removed } = changes;

  /**
   * One file needs no choosing, so it arrives open.
   *
   * Opening the line and then opening its only row is two clicks to reach the one thing
   * behind them. Derived rather than held, so a turn still running that goes on to touch a
   * second file closes again: with two there is a choice, and opening one of them for the
   * reader would be making it for them.
   */
  const lone = files.length === 1 ? files[0]!.path : null;
  const shown = picked === undefined ? lone : picked;

  return (
    <div className={open ? 'turn-changes open' : 'turn-changes'}>
      <button type="button" className="turn-changes-head" onClick={() => onView({ ...view, open: !open })}>
        <ChevronIcon open={open} />
        <span className="turn-changes-label">
          {files.length === 1 ? '1 file changed' : `${files.length} files changed`}
        </span>
        <span className="tool-counts">
          {added > 0 && <span className="added">+{added}</span>}
          {removed > 0 && <span className="removed">−{removed}</span>}
        </span>
      </button>

      {open && (
        <ul className="turn-changes-files">
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              open={shown === file.path}
              onToggle={() => onView({ ...view, picked: shown === file.path ? null : file.path })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Every edit the turn made to one file, as one diff.
 *
 * The edits are kept apart until here because each one's line numbers count the file as the
 * edit before it left it, so their hunks cannot be interleaved. Laid end to end with a gap
 * between them they read as one file's worth of change, which is the question being asked -
 * what did this turn do to this file - rather than a list of the writes it took to get there.
 */
function allEdits(patches: string[]): PatchLine[] {
  const gap: PatchLine = { kind: 'skip', text: '', before: null, after: null };
  return patches.flatMap((patch, at) => (at === 0 ? parsePatch(patch) : [gap, ...parsePatch(patch)]));
}

function FileRow({ file, open, onToggle }: { file: ChangedFile; open: boolean; onToggle: () => void }) {
  const { name, within } = nameOf(file.path);
  const badge = fileBadge(file.path);
  const edits = file.patches.length;

  return (
    <li>
      <button
        type="button"
        className={open ? 'turn-changes-file open' : 'turn-changes-file'}
        onClick={onToggle}
        aria-expanded={open}
        title={file.path}
      >
        <ChevronIcon open={open} />
        {badge && (
          <span className="tool-badge" data-tone={badge.tone}>
            {badge.label}
          </span>
        )}
        <span className="turn-changes-name">{name}</span>
        {/* Always drawn, blank for a file that sits at the root of the working directory:
            this is the part that takes the leftover room, so without it the counts would
            stop beside the name instead of at the right edge. */}
        <span className="turn-changes-where">{within}</span>
        {/* Only when it was written more than once: on most rows it would be a 1 beside
            every file, saying nothing. */}
        {edits > 1 && <span className="turn-changes-edits">{edits} edits</span>}
        <span className="tool-counts">
          {file.added > 0 && <span className="added">+{file.added}</span>}
          {file.removed > 0 && <span className="removed">−{file.removed}</span>}
        </span>
      </button>

      {open && (
        <div className="turn-changes-diffs">
          <Diff lines={allEdits(file.patches)} />
        </div>
      )}
    </li>
  );
}
