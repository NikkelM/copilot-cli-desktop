import { useEffect, useRef, useState } from 'react';

import { normalise } from '../lib/useTags';

/**
 * What is true about a session right now, as a list to tick and a box to add to.
 *
 * A dialog rather than a submenu on the right-click menu. Tags are many to a session and are
 * changed in handfuls - one on, two off, a new one - and a menu that closes on every choice
 * would mean reopening it for each (#123).
 *
 * Tags already in use are offered, because a list where half the sessions read `needs-review`
 * and the other half `needs review` is worth less than either spelling alone.
 */
export function TagPicker({
  title,
  held,
  known,
  onToggle,
  onClose,
}: {
  /** The session being tagged, so the dialog says what it is about. */
  title: string;
  held: readonly string[];
  /** Every tag in use anywhere, commonest first. */
  known: readonly string[];
  onToggle: (tag: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLInputElement>(null);

  /**
   * The order the chips are drawn in, taken once when the dialog opens.
   *
   * What is true reads before what could be, but only at the moment of asking. Recomputing it
   * as tags are ticked would move each one to the front as it was chosen, so the next one
   * someone reached for would have moved somewhere else under the pointer - and tags are
   * changed in handfuls, which is the whole reason this is a dialog.
   */
  const [order, setOrder] = useState<string[]>(() => [
    ...held,
    ...known.filter((tag) => !held.includes(tag)),
  ]);

  // A tag invented while the dialog is open joins the end rather than displacing anything.
  useEffect(() => {
    const drawn = new Set(order);
    const added = [...new Set([...held, ...known])].filter((tag) => !drawn.has(tag));
    if (added.length > 0) setOrder((current) => [...current, ...added]);
  }, [held, known, order]);

  useEffect(() => field.current?.focus(), []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const add = () => {
    const tag = normalise(draft);
    // Adding one already on the session would take it off, which is not what typing a name
    // into a box called "add" means.
    if (tag && !held.includes(tag)) onToggle(tag);
    setDraft('');
  };

  // The ones already on the session first, as they were when the dialog opened.
  const offered = order;

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm tag-picker"
        role="dialog"
        aria-modal="true"
        aria-label={`Tags for ${title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-title">Tags</h2>
        <p className="confirm-body">{title}</p>

        <form
          className="tag-add"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <input
            ref={field}
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a tag"
            aria-label="Add a tag"
            spellCheck={false}
          />
          <button type="submit" disabled={normalise(draft) === ''}>
            Add
          </button>
        </form>

        {offered.length > 0 && (
          <ul className="tag-list">
            {offered.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  className={held.includes(tag) ? 'tag on' : 'tag'}
                  aria-pressed={held.includes(tag)}
                  onClick={() => onToggle(tag)}
                >
                  {tag}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
