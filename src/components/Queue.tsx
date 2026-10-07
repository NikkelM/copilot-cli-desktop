import { useEffect, useRef, useState } from 'react';

import type { QueuedItem } from '../../shared/protocol';

interface QueueProps {
  items: QueuedItem[];
  /** Absent while nothing can be changed, which is what a session nobody holds looks like. */
  onRemove?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
  onMove?: (id: string, to: number) => void;
  onClear?: () => void;
}

/**
 * What is waiting behind the turn that is running.
 *
 * Shown between the transcript and the composer, where it reads as what it is: asked for
 * but not started yet. Without this a message typed mid-turn vanishes for a minute and then
 * appears, which looks like the app losing it and then finding it again.
 *
 * Changeable while it waits (#76). The commonest thing to want is to take one back - a
 * follow-up written mid-turn that the turn then answers on its own - and the runtime is
 * consuming from this list the whole time, so an entry can be taken while somebody is
 * deciding. Nothing here warns about that: it simply stops being on the list.
 */
export function Queue({ items, onRemove, onEdit, onMove, onClear }: QueueProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (!items.length) return null;

  const open = (item: QueuedItem) => {
    setEditing(item.id);
    setDraft(item.text);
  };

  const save = (id: string) => {
    const text = draft.trim();
    // An entry emptied is an entry nobody wants, which is the other way of saying remove.
    if (!text) onRemove?.(id);
    else onEdit?.(id, text);
    setEditing(null);
  };

  return (
    <div className="queue">
      <p className="queue-head">
        {items.length} queued, run when the agent finishes
        {onClear && (
          <button type="button" className="queue-clear" onClick={onClear} title="Drop everything waiting">
            Clear
          </button>
        )}
      </p>
      <ol className="queue-list">
        {items.map((item, index) => (
          <li key={item.id} className={index === 0 ? 'queue-item next' : 'queue-item'}>
            {/* Which one goes next is the only ordering anyone needs to see. */}
            <span className="queue-position">{index === 0 ? 'Next' : index + 1}</span>

            {editing === item.id ? (
              <QueueEditor
                value={draft}
                onChange={setDraft}
                onSave={() => save(item.id)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <>
                {/* A queued command is not a message, and reads as one without saying so. */}
                <span className={item.kind === 'message' ? 'queue-text' : 'queue-text command'}>{item.text}</span>

                <span className="queue-actions">
                  {/* Only a message can be rewritten: a queued command or a model change is
                      not text somebody wrote, and editing one would mean nothing. */}
                  {onEdit && item.kind === 'message' && (
                    <button type="button" onClick={() => open(item)} title="Edit this message" aria-label="Edit this message">
                      Edit
                    </button>
                  )}
                  {onMove && items.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() => onMove(item.id, index - 1)}
                        disabled={index === 0}
                        title="Run this one sooner"
                        aria-label="Run this one sooner"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => onMove(item.id, index + 1)}
                        disabled={index === items.length - 1}
                        title="Run this one later"
                        aria-label="Run this one later"
                      >
                        ↓
                      </button>
                    </>
                  )}
                  {onRemove && (
                    <button type="button" onClick={() => onRemove(item.id)} title="Take this back" aria-label="Take this back">
                      ✕
                    </button>
                  )}
                </span>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * One waiting message, open for rewriting.
 *
 * Enter saves and Escape abandons, which is what every other single-line box in this app
 * does. Shift+Enter is left alone: a queued message can be more than one line.
 */
function QueueEditor({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <textarea
      ref={ref}
      className="queue-edit"
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          onSave();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      // Clicking elsewhere keeps what was written, since the alternative is losing an edit
      // to a misplaced click.
      onBlur={onSave}
    />
  );
}