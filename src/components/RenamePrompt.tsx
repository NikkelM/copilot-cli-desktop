import { useEffect, useRef, useState } from 'react';

/**
 * Give a session a name of somebody's choosing.
 *
 * A dialog rather than editing the row in place. A session's name is the one thing on the row
 * that says which session it is, and a row that turns into a text box while the list is being
 * read is easy to leave half-edited (#29).
 *
 * Opens with what the session is called, selected, since renaming is usually correcting
 * rather than starting again.
 */
export function RenamePrompt({
  current,
  onRename,
  onClose,
}: {
  /** What it is called now, which is where the box starts. */
  current: string;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(current);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const wanted = draft.trim();
  // Nothing to do for a name that is not a name, or for the one it already has.
  const settled = wanted === '' || wanted === current.trim();

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm"
        role="dialog"
        aria-modal="true"
        aria-label="Rename this session"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-title">Rename</h2>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            onRename(wanted);
            onClose();
          }}
        >
          <input
            ref={field}
            type="text"
            className="rename-field"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Session name"
            spellCheck={false}
          />

          <div className="confirm-actions">
            <button type="button" className="confirm-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={settled}>
              Rename
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
