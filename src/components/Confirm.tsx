import { useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../lib/useFocusTrap';

/**
 * The question asked before something irreversible happens.
 *
 * Over the app rather than beside it, because the answer decides whether the thing happens
 * at all: a question that can be ignored is one that will be, and this one cannot be taken
 * back once answered.
 *
 * The confirming button is never the one focused on open. A reader who dismisses dialogs by
 * reflex should land on the way out, not on the way through.
 */
export function Confirm({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  remember,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** What will be lost, in the reader's terms. */
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Offers to stop asking. Absent leaves the question unskippable, which some are. */
  remember?: string;
  /** Told whether the reader asked not to be asked again. */
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box);

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
      {/* The click that opens the dialog must not also close it, and neither must one aimed
          at the dialog that happens to finish outside it. */}
      <div
        className="confirm"
        ref={box}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-title">{title}</h2>
        <div className="confirm-body">{body}</div>

        {remember !== undefined && (
          <label className="confirm-remember">
            <input type="checkbox" checked={dontAsk} onChange={(event) => setDontAsk(event.target.checked)} />
            {remember}
          </label>
        )}

        <div className="confirm-actions">
          <button type="button" ref={cancel} className="confirm-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="confirm-go" onClick={() => onConfirm(dontAsk)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
