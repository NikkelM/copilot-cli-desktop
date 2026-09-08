import { useEffect, useState } from 'react';

import type { FileDiff, SessionChange } from '../../shared/protocol';
import { parsePatch } from '../lib/patch';
import { relativise } from '../lib/paths';
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
  /** Mark everything listed as seen, so next time only what is newer shows. */
  onReview: () => void;
  /** How far this session has been reviewed, or null if it never has. */
  reviewedAt: string | null;
  /** Whether the whole session is on show rather than only what is new. */
  showAll: boolean;
  onSpan: (all: boolean) => void;
}

const GLYPH: Record<SessionChange['status'], string> = {
  created: '+',
  modified: '~',
  deleted: '−',
};

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
   * left open has to ask again rather than sit on "Reading the diff." for good. A row whose
   * file has dropped off the list has nothing left to ask about, so it closes.
   */
  useEffect(() => {
    if (!open) return;
    if (changes && !changes.some((change) => change.path === open)) setOpen(null);
    else onDiff(open);
  }, [open, changes, onDiff]);

  function toggle(path: string) {
    setOpen(open === path ? null : path);
  }

  const added = changes?.reduce((n, change) => n + change.linesAdded, 0) ?? 0;
  const removed = changes?.reduce((n, change) => n + change.linesRemoved, 0) ?? 0;
  const since = reviewedAt !== null && !showAll;

  return (
    <div className="changes">
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
          {changes && changes.length > 0 && (
            <button
              type="button"
              className="changes-action primary"
              onClick={onReview}
              title="Mark these as seen, so opening this again shows only what is newer"
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
      {loading && !changes && <p className="changes-note">Reading what this session changed.</p>}
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
            Nothing recorded. A session only leaves a record for tools that name the file they change, so work done
            through the shell does not appear here.
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
                title={change.path}
              >
                <span className={`changes-status ${change.status}`}>{GLYPH[change.status]}</span>
                <span className="changes-path">{relativise(change.path, cwd)}</span>
                {change.turns > 1 && <span className="changes-turns">{change.turns} turns</span>}
                <span className="changes-counts">
                  {change.linesAdded > 0 && <span className="added">+{change.linesAdded}</span>}
                  {change.linesRemoved > 0 && <span className="removed">−{change.linesRemoved}</span>}
                </span>
              </button>

              {open === change.path && <Expanded diff={diffs[change.path]} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Why there is no diff is worth as much as the diff, so it is said rather than left blank. */
const WHY: Record<NonNullable<FileDiff['reason']>, string> = {
  gone: 'This file is not on disk any more, and no copy of its contents was kept.',
  replaced: 'The file on disk is no longer the version the session left, and no copy of that version was kept.',
  binary: 'Not a text file.',
  untracked: 'No snapshot mentions this file.',
};

function Expanded({ diff }: { diff: FileDiff | undefined }) {
  if (!diff) return <p className="changes-note">Reading the diff.</p>;
  if (!diff.patch) return <p className="changes-note">{diff.reason ? WHY[diff.reason] : 'No diff to show.'}</p>;

  return (
    <>
      {/* The file has moved on since. Saying so is what stops the diff being read as the
          file's current state, and stops someone else's edit looking like the agent's. */}
      {diff.stale && <p className="changes-note">Changed again since the session left it, so this is not the file as it stands.</p>}
      <Diff lines={parsePatch(diff.patch)} />
    </>
  );
}
