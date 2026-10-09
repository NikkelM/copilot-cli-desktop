import { useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../lib/useFocusTrap';

import type { MergeStrategy } from '../../shared/protocol';

/**
 * How to reconcile a branch with a remote that has moved on too.
 *
 * Asked rather than assumed, because there is no right answer: rebasing rewrites the local
 * commits onto the remote's, merging keeps both and writes a commit joining them, and which
 * of those a repository wants is a convention rather than a fact. The CLI takes the same
 * position - its `mergeStrategy` has no default, and it asks with these same four
 * answers (#205).
 *
 * The question only comes up when the fast-forward this panel prefers has already been
 * refused, so nothing has happened yet and putting it away leaves the branch alone.
 */
export function MergeChoice({
  onChoose,
  onCancel,
}: {
  /** Told which way, and whether to stop asking by writing it to the CLI's settings. */
  onChoose: (strategy: MergeStrategy, remember: boolean) => void;
  onCancel: () => void;
}) {
  const [remember, setRemember] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box);

  // As with every other question here: a reader dismissing by reflex lands on the way out.
  useEffect(() => cancel.current?.focus(), []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onCancel]);

  return (
    <div className="confirm-backdrop" onMouseDown={onCancel}>
      <div
        className="confirm"
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Choose how to pull"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-title">This branch and the remote have both moved on</h2>

        <label className="confirm-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          Remember this choice
        </label>

        <div className="confirm-actions">
          <button type="button" ref={cancel} className="confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => onChoose('merge', remember)}>
            Merge
          </button>
          <button type="button" onClick={() => onChoose('rebase', remember)}>
            Rebase
          </button>
        </div>
      </div>
    </div>
  );
}
