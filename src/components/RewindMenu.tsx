import { useEffect, useRef, useState } from 'react';

import type { RewindPoint, RewindPreview } from '../../shared/protocol';
import { relativise } from '../lib/paths';
import { formatRelative } from '../lib/time';

/**
 * Where to put a session back to, and what to put back (#156).
 *
 * Two steps, as the CLI asks them: which turn, then whether the files go with it. Kept as
 * one component because the second question is about the answer to the first - splitting
 * them would mean a caller holding half a decision.
 *
 * Numbered from the end rather than the beginning, as the CLI numbers them: the turn
 * somebody wants is almost always a recent one, and counting back from now is how they
 * think of it ("three turns ago") rather than counting up from a session they opened days
 * ago.
 */
export function RewindMenu({
  points,
  loading,
  failed,
  unavailable,
  picked,
  preview,
  cwd,
  onPick,
  onRewind,
  onClose,
}: {
  points: RewindPoint[];
  loading: boolean;
  failed: string | null;
  unavailable: 'untracked' | 'busy' | 'remote' | null;
  /** The turn chosen, which moves this to its second question. */
  picked: RewindPoint | null;
  /** What that turn would put back, or null while it is still being read. */
  preview: RewindPreview | null;
  cwd: string | null;
  onPick: (point: RewindPoint) => void;
  onRewind: (point: RewindPoint, files: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm rewind"
        role="dialog"
        aria-modal="true"
        aria-label={picked ? 'Rewind turn' : 'Rewind to a previous point'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {picked ? (
          <Scope point={picked} preview={preview} cwd={cwd} onRewind={onRewind} onClose={onClose} />
        ) : (
          <Points
            points={points}
            loading={loading}
            failed={failed}
            unavailable={unavailable}
            onPick={onPick}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

/** Why a session cannot be put back, said in the reader's terms rather than the runtime's. */
const WHY: Record<'untracked' | 'busy' | 'remote', string> = {
  untracked: 'This session did not record what it changed, so it cannot be rewound.',
  busy: 'This session is still working. Rewinding needs it to settle first, so try again in a moment.',
  remote: 'A session running elsewhere cannot be rewound from here.',
};

function Points({
  points,
  loading,
  failed,
  unavailable,
  onPick,
  onClose,
}: {
  points: RewindPoint[];
  loading: boolean;
  failed: string | null;
  unavailable: 'untracked' | 'busy' | 'remote' | null;
  onPick: (point: RewindPoint) => void;
  onClose: () => void;
}) {
  // The newest is the one most often wanted, and it is the one at the bottom.
  const [at, setAt] = useState(Math.max(0, points.length - 1));
  const list = useRef<HTMLUListElement>(null);

  // The list arrives after the menu opens, so where to start is only known once it has.
  useEffect(() => setAt(Math.max(0, points.length - 1)), [points.length]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose();
      if (points.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setAt((index) => Math.min(points.length - 1, index + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setAt((index) => Math.max(0, index - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const point = points[at];
        if (point) onPick(point);
      }
    };

    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [points, at, onPick, onClose]);

  // Keeps the chosen row in view while arrowing through a long session.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  return (
    <>
      <h2 className="confirm-title">Rewind to a previous point</h2>

      {failed && <p className="error">{failed}</p>}
      {unavailable && <p className="changes-note">{WHY[unavailable]}</p>}
      {loading && points.length === 0 && !unavailable && (
        <p className="changes-note">Reading where this session can go back to.</p>
      )}
      {!loading && !failed && !unavailable && points.length === 0 && (
        <p className="changes-note">This session has no turns to go back to yet.</p>
      )}

      {points.length > 0 && (
        <ul className="rewind-points" ref={list} role="listbox" aria-label="Turns to rewind to">
          {points.map((point, index) => (
            <li key={point.eventId}>
              <button
                type="button"
                role="option"
                aria-selected={index === at}
                className={index === at ? 'rewind-point on' : 'rewind-point'}
                onMouseEnter={() => setAt(index)}
                onClick={() => onPick(point)}
              >
                <span className="rewind-number">{points.length - index}.</span>
                <span className="rewind-said">{point.message.trim() || 'No prompt text'}</span>
                {point.fileCount > 0 && (
                  <span className="tool-counts">
                    {point.linesAdded > 0 && <span className="added">+{point.linesAdded}</span>}
                    {point.linesRemoved > 0 && <span className="removed">−{point.linesRemoved}</span>}
                  </span>
                )}
                <span className="rewind-when">{formatRelative(point.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="rewind-keys">↑↓ Navigate · Enter Select · Esc Cancel</p>
    </>
  );
}

function Scope({
  point,
  preview,
  cwd,
  onRewind,
  onClose,
}: {
  point: RewindPoint;
  preview: RewindPreview | null;
  cwd: string | null;
  onRewind: (point: RewindPoint, files: boolean) => void;
  onClose: () => void;
}) {
  /**
   * Whether putting the files back is on offer.
   *
   * The turn says whether anything was captured; the preview says whether it can still be
   * restored. Both have to agree, and until the preview arrives the answer is not known -
   * so the option waits rather than being offered and then failing.
   */
  const canRestore = point.canRestoreFiles && preview !== null && preview.available && preview.files.length > 0;
  const [at, setAt] = useState(0);
  const options = [0, 1, 2];

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose();

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setAt((index) => Math.min(options.length - 1, index + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setAt((index) => Math.max(0, index - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (at === 0) onRewind(point, false);
        else if (at === 1 && canRestore) onRewind(point, true);
        else if (at === 2) onClose();
      }
    };

    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [at, canRestore, onRewind, onClose, point, options.length]);

  return (
    <>
      <h2 className="confirm-title">Rewind this turn</h2>
      <p className="rewind-said-full">{point.message.trim() || 'No prompt text'}</p>
      {/* Said once, plainly, and above the choice rather than after it: the conversation
          goes whichever option is taken, and that is the part that cannot be undone. */}
      <p className="changes-note">
        Everything after this turn will be discarded, and the conversation does not come back.
      </p>

      <ul className="rewind-scope" role="listbox" aria-label="What to rewind">
        <li>
          <button
            type="button"
            role="option"
            aria-selected={at === 0}
            className={at === 0 ? 'rewind-choice on' : 'rewind-choice'}
            onMouseEnter={() => setAt(0)}
            onClick={() => onRewind(point, false)}
          >
            <span className="rewind-choice-label">Conversation only</span>
            <span className="rewind-choice-note">Files left untouched</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            role="option"
            aria-selected={at === 1}
            className={at === 1 ? 'rewind-choice on' : 'rewind-choice'}
            disabled={!canRestore}
            onMouseEnter={() => canRestore && setAt(1)}
            onClick={() => onRewind(point, true)}
          >
            <span className="rewind-choice-label">Conversation and files</span>
            <span className="rewind-choice-note">
              {preview === null
                ? 'Reading what this would put back.'
                : canRestore
                  ? `Put back ${preview.files.length} ${preview.files.length === 1 ? 'file' : 'files'}, losing any later changes to them`
                  : 'No file changes to put back'}
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            role="option"
            aria-selected={at === 2}
            className={at === 2 ? 'rewind-choice on' : 'rewind-choice'}
            onMouseEnter={() => setAt(2)}
            onClick={onClose}
          >
            <span className="rewind-choice-label">Cancel</span>
          </button>
        </li>
      </ul>

      {canRestore && preview && (
        <ul className="rewind-files">
          {preview.files.map((file) => (
            <li key={file.path}>
              <span className={`changes-status ${file.status}`}>
                {file.status === 'created' ? '+' : file.status === 'deleted' ? '−' : '~'}
              </span>
              <span className="changes-path">{relativise(file.path, cwd)}</span>
              <span className="tool-counts">
                {file.linesAdded > 0 && <span className="added">+{file.linesAdded}</span>}
                {file.linesRemoved > 0 && <span className="removed">−{file.linesRemoved}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="rewind-keys">↑↓ Navigate · Enter Select · Esc Cancel</p>
    </>
  );
}
