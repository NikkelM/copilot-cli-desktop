import { useEffect, useRef, useState } from 'react';

import type { FileDiff, SessionChange } from '../../shared/protocol';
import { fileBadge } from '../lib/fileBadge';
import { mergeEdits, parsePatch } from '../lib/patch';
import { relativise } from '../lib/paths';
import { step } from '../lib/roving';
import { Diff } from './Diff';

interface ChangesProps {
  changes: SessionChange[] | null;
  loading: boolean;
  failed: string | null;
  /** Diffs already fetched, by path. */
  diffs: Record<string, FileDiff>;
  /** Fetch one, when a row is opened. */
  onDiff: (path: string) => void;
  /** Shortens paths to the part that identifies them. */
  cwd: string | null;
  onClose: () => void;
  /**
   * Mark everything listed as seen, so next time only what is newer shows.
   *
   * Absent where there is nothing to review: a delegated run has finished, and its account
   * of what it changed is not going to grow.
   */
  onReview?: () => void;
  /** How far this session has been reviewed, or null if it never has. */
  reviewedAt: string | null;
  /** Whether the whole session is on show rather than only what is new. */
  showAll: boolean;
  onSpan: (all: boolean) => void;
  /** Whose work is being read, for the line shown while the list is on its way. */
  whose?: string;
}

const GLYPH: Record<SessionChange['status'], string> = {
  created: '+',
  modified: '~',
  deleted: '−',
};

/**
 * The file's type, beside the mark saying what happened to it.
 *
 * Always rendered, blank when the type is unknown, so the paths of a list of mixed types
 * still line up. Here the badge sits beside the status mark rather than replacing it: a
 * created file and a deleted one are the whole point of this list.
 */
function FileBadge({ path }: { path: string }) {
  const badge = fileBadge(path);
  return (
    <span className="changes-badge" data-tone={badge?.tone}>
      {badge?.label ?? ''}
    </span>
  );
}

/**
 * Put the whole path on a row whose path did not fit, and take it off one whose did.
 *
 * The browser trims it with an ellipsis, so whether anything was lost is a fact about the
 * layout rather than about the change - it depends on how wide the panel has been dragged.
 * Asked when the row is reached rather than held, since the answer changes with the window
 * and a label that repeats what is already written helps nobody.
 */
function sayIfCut(event: { currentTarget: HTMLElement }) {
  const path = event.currentTarget.querySelector<HTMLElement>('.changes-path');
  if (!path) return;

  if (path.scrollWidth > path.clientWidth) path.title = path.dataset.full ?? '';
  else path.removeAttribute('title');
}

/**
 * Everything this session changed, and the diff for any of it.
 *
 * The session's own work and nothing else - the rewind snapshots are written around the
 * tool calls that made each change, so an edit someone made in an editor alongside never
 * enters them. That is the distinction the question is really asking about, and the one a
 * diff of the working directory cannot draw.
 */
export function Changes({
  changes,
  loading,
  failed,
  diffs,
  onDiff,
  cwd,
  onClose,
  onReview,
  reviewedAt,
  showAll,
  onSpan,
  whose = 'this session',
}: ChangesProps) {
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  /**
   * Keep whatever is open answered.
   *
   * The list can be reread underneath the panel - a turn ends, or the span changes - which
   * drops the diffs on hand, since they answered the question the old span asked. A row
   * left open has to ask again rather than sit on "Reading the diff." for good.
   *
   * A file that is not in the list right now is remembered rather than closed. It drops out
   * at the seam between a turn and the store: the running turn's record is let go when the
   * session goes idle, and the snapshot that replaces it is not written until the moment
   * the next turn begins. Closing on that emptied the row somebody was reading, twice per
   * turn, and left it shut when the file came back.
   */
  useEffect(() => {
    if (!open) return;
    // Nothing to ask about while it is out of the list, but it is still the row somebody
    // has open, so it is asked again as soon as it is back.
    if (!changes || changes.some((change) => change.path === open)) onDiff(open);
  }, [open, changes, onDiff]);

  function toggle(path: string) {
    setOpen(open === path ? null : path);
  }

  const added = changes?.reduce((n, change) => n + change.linesAdded, 0) ?? 0;
  const removed = changes?.reduce((n, change) => n + change.linesRemoved, 0) ?? 0;
  const since = reviewedAt !== null && !showAll;
  const box = useRef<HTMLDivElement>(null);

  return (
    <div
      className="changes"
      data-region="panel"
      tabIndex={-1}
      ref={box}
      // Up and down walk the files, as they walk the sessions in the sidebar. Claimed rather
      // than left to the panel's own scrolling, since moving between the rows is what a
      // reader means by an arrow on a list.
      onKeyDown={(event) => {
        // Inside an open diff the arrows belong to the diff: somebody who has gone in to
        // read it means to scroll it, not to be taken back out to the next file.
        if ((event.target as HTMLElement).closest('.changes-diff, .tool-diff, pre, code')) return;

        const by =
          event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : null;
        if (by === null) return;
        if (step(box.current, '.changes-row', by)) event.preventDefault();
      }}
    >
      <div className="changes-head">
        <span className="changes-title">
          {changes ? `${changes.length} ${changes.length === 1 ? 'file' : 'files'} changed` : 'Changes'}
          {since && changes !== null && <span className="changes-span"> since you last reviewed</span>}
        </span>
        {changes && changes.length > 0 && (
          <span className="changes-total">
            <span className="added">+{added}</span> <span className="removed">−{removed}</span>
          </span>
        )}
        <div className="changes-actions">
          {reviewedAt !== null && (
            <button type="button" className="changes-action" onClick={() => onSpan(!showAll)}>
              {showAll ? 'Only what is new' : 'Whole session'}
            </button>
          )}
          {onReview && changes && changes.length > 0 && (
            <button
              type="button"
              className="changes-action primary"
              onClick={onReview}
              title="Mark these changes as seen"
            >
              Seen this
            </button>
          )}
          <button type="button" className="changes-close" onClick={onClose} aria-label="Close changes">
            ✕
          </button>
        </div>
      </div>

      {failed && <p className="error">{failed}</p>}
      {loading && !changes && <p className="changes-note">Reading what {whose} changed.</p>}
      {changes?.length === 0 &&
        (since ? (
          <p className="changes-note">
            Nothing new since you reviewed this.{' '}
            <button type="button" className="changes-link" onClick={() => onSpan(true)}>
              Show the whole session
            </button>
          </p>
        ) : (
          <p className="changes-note">
            No changes recorded. Shell commands are not tracked here.
          </p>
        ))}

      {changes && changes.length > 0 && (
        <ul className="changes-list">
          {changes.map((change) => (
            <li key={change.path}>
              <button
                type="button"
                className={open === change.path ? 'changes-row open' : 'changes-row'}
                onClick={() => toggle(change.path)}
                aria-expanded={open === change.path}
                // Named only when the name on screen is not the whole of it. Whether it was
                // cut is a fact about the layout - the path is trimmed with an ellipsis by
                // the stylesheet - so it can only be asked once the row is being looked at,
                // which is the moment a label would be drawn anyway.
                onMouseEnter={sayIfCut}
                onFocus={sayIfCut}
              >
                <span className={`changes-status ${change.status}`}>{GLYPH[change.status]}</span>
                <FileBadge path={change.path} />
                <span className="changes-path" data-full={change.path}>
                  {relativise(change.path, cwd)}
                </span>
                {change.turns > 1 && <span className="changes-turns">{change.turns} turns</span>}
                {/* A count that is about to change must not read as final, and the row has
                    no diff behind it yet: the before image is the CLI's to write, and it
                    writes it when the turn ends (#140). */}
                {change.running && <span className="changes-running">still working</span>}
                <span className="changes-counts">
                  {change.linesAdded > 0 && <span className="added">+{change.linesAdded}</span>}
                  {change.linesRemoved > 0 && <span className="removed">−{change.linesRemoved}</span>}
                </span>
              </button>

              {open === change.path && <Expanded diff={diffs[change.path]} running={change.running} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Why there is no diff is worth as much as the diff, so it is said rather than left blank. */
const WHY: Record<NonNullable<FileDiff['reason']>, string> = {
  gone: 'File no longer exists, and no snapshot was kept.',
  replaced: 'Changed since this session wrote it, and no snapshot was kept.',
  binary: 'Not a text file.',
  'too-large': 'Too large to compare.',
  untracked: 'No snapshot was taken of this file.',
};

function Expanded({ diff, running }: { diff: FileDiff | undefined; running?: boolean }) {
  if (!diff) return <p className="changes-note">{running ? 'Reading what it has written.' : 'Reading the diff.'}</p>;

  /*
   * What a running turn has written so far (#140).
   *
   * Joined here rather than in the sidecar, with the same code the summary at the end of a
   * turn uses, so the two views of one turn's work cannot come out differently.
   */
  if (diff.patches?.length) return <Diff lines={mergeEdits(diff.patches)} />;

  if (!diff.patch) return <p className="changes-note">{diff.reason ? WHY[diff.reason] : 'No diff to show.'}</p>;

  return (
    <>
      {/* The file has moved on since. Saying so is what stops the diff being read as the
          file's current state, and stops someone else's edit looking like the agent's. */}
      {diff.stale && <p className="changes-note">Changed since this session wrote it. This diff is not the current file.</p>}
      <Diff lines={parsePatch(diff.patch)} />
    </>
  );
}
