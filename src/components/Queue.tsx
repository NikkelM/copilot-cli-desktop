import { useEffect, useRef } from 'react';

import type { QueuedItem } from '../../shared/protocol';
import { step, stepRows } from '../lib/roving';

interface QueueProps {
  items: QueuedItem[];
  /** Absent while nothing can be changed, which is what a session nobody holds looks like. */
  onRemove?: (id: string) => void;
  /** Hands the message to the composer, which is where it is rewritten. */
  onEdit?: (item: QueuedItem) => void;
  onMove?: (id: string, to: number) => void;
  onClear?: () => void;
  /** Hand one to the turn already running, rather than waiting for the next. */
  onSendNow?: (id: string) => void;
  /** Hold the queue where it is, or let it go again. */
  onHold?: (paused: boolean) => void;
  held?: boolean;
  /** Which message is being rewritten in the composer, if any. */
  editing?: string | null;
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
export function Queue({ items, onRemove, onEdit, onMove, onClear, onSendNow, onHold, held, editing }: QueueProps) {
  const list = useRef<HTMLOListElement>(null);
  /**
   * The message a move was asked for, and which of its two buttons asked.
   *
   * Moving redraws the list with the rows in a new order, and the button that was pressed
   * can be refused in its new place - a message moved to the front has nothing above it -
   * so the keyboard was dropped on the floor. Held until the render that moves it has run,
   * then handed back to the same message.
   */
  const moved = useRef<{ id: string; way: 'up' | 'down' } | null>(null);

  useEffect(() => {
    const was = moved.current;
    if (!was) return;
    moved.current = null;

    const row = list.current?.querySelector<HTMLElement>(`[data-queued="${CSS.escape(was.id)}"]`);
    if (!row) return;

    // The same button where it can still be pressed, and the other one where it cannot:
    // at either end of the queue one of the two is always refused, and the keyboard has to
    // land on something.
    const same = row.querySelector<HTMLElement>(`[data-way="${was.way}"]`);
    const other = row.querySelector<HTMLElement>(`[data-way="${was.way === 'up' ? 'down' : 'up'}"]`);
    const landing = same && !same.hasAttribute('disabled') ? same : other;
    landing?.focus();
  }, [items]);

  if (!items.length) return null;

  return (
    <div className={held ? 'queue held' : 'queue'}>
      <p className="queue-head">
        {held ? `${items.length} held, nothing will run until released` : `${items.length} queued, run when the agent finishes`}
        {onHold && (
          <button
            type="button"
            className="queue-clear"
            onClick={() => onHold(!held)}
            title={held ? 'Let the queue run again' : 'Stop anything else starting until released'}
          >
            {held ? 'Release' : 'Hold'}
          </button>
        )}
        {onClear && (
          <button type="button" className="queue-clear" onClick={onClear} title="Drop everything waiting">
            Clear
          </button>
        )}
      </p>
      <ol
        className="queue-list"
        ref={list}
        // Up and down are about which message, left and right about what to do to it - the
        // rows carry up to five controls each, and walking them one at a time was the whole
        // of the complaint. Ctrl and an arrow moves the message itself, which until now was
        // offered only as a pair of buttons to find and press.
        onKeyDown={(event) => {
          if (event.altKey || event.metaKey) return;
          const down = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;

          if (event.ctrlKey) {
            if (down === 0 || !onMove) return;
            const row = (event.target as HTMLElement).closest<HTMLElement>('.queue-item');
            const id = row?.dataset.queued;
            const at = items.findIndex((item) => item.id === id);
            // Off either end there is nowhere to go, and the press belongs to whatever else
            // wanted it rather than being swallowed for nothing.
            if (at === -1 || at + down < 0 || at + down >= items.length) return;

            event.preventDefault();
            moved.current = { id: id!, way: down === 1 ? 'down' : 'up' };
            onMove(id!, at + down);
            return;
          }

          if (down !== 0) {
            if (stepRows(list.current, '.queue-item', 'button', down === 1 ? 1 : -1)) event.preventDefault();
            return;
          }

          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const row = (event.target as HTMLElement).closest<HTMLElement>('.queue-item');
            if (step(row, 'button', event.key === 'ArrowRight' ? 1 : -1)) event.preventDefault();
          }
        }}
      >
        {items.map((item, index) => (
          <li
            key={item.id}
            data-queued={item.id}
            className={`queue-item${index === 0 ? ' next' : ''}${editing === item.id ? ' editing' : ''}`}
          >
            {/* Which one goes next is the only ordering anyone needs to see. */}
            <span className="queue-position">{index === 0 ? 'Next' : index + 1}</span>

            {/* A queued command is not a message, and reads as one without saying so. */}
            <span className={item.kind === 'message' ? 'queue-text' : 'queue-text command'}>
              {item.text}
              {/* Only ever said where it is known. The runtime does not report what a
                  waiting message carries, so nothing is claimed about one sent from a
                  terminal attached to the same session. */}
              {item.attachments?.length ? (
                <span
                  className="queue-attached"
                  title={item.attachments.map((file) => file.displayName ?? file.path).join('\n')}
                >
                  {item.attachments.length === 1 ? '1 file' : `${item.attachments.length} files`}
                </span>
              ) : null}
            </span>

            <span className="queue-actions">
              {/* Into the turn already running rather than the next one, which only a
                  message can be: a queued command or model change is not something for
                  the agent to take account of mid-answer. */}
              {onSendNow && item.kind === 'message' && (
                <button
                  type="button"
                  onClick={() => onSendNow(item.id)}
                  title="Send this into the turn that is running"
                  aria-label="Send this into the turn that is running"
                >
                  Now
                </button>
              )}
              {/* Only a message can be rewritten: a queued command or a model change is
                  not text somebody wrote, and editing one would mean nothing. */}
              {onEdit && item.kind === 'message' && (
                <button type="button" onClick={() => onEdit(item)} title="Edit this message" aria-label="Edit this message">
                  Edit
                </button>
              )}
              {onMove && items.length > 1 && (
                <>
                  <button
                    type="button"
                    data-way="up"
                    onClick={() => {
                      moved.current = { id: item.id, way: 'up' };
                      onMove(item.id, index - 1);
                    }}
                    disabled={index === 0}
                    title="Run this one sooner"
                    aria-label="Run this one sooner"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    data-way="down"
                    onClick={() => {
                      moved.current = { id: item.id, way: 'down' };
                      onMove(item.id, index + 1);
                    }}
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
            </span>          </li>
        ))}
      </ol>
    </div>
  );
}
