import type { QueuedItem } from '../../shared/protocol';

/**
 * What is waiting behind the turn that is running.
 *
 * Shown between the transcript and the composer, where it reads as what it is: asked for
 * but not started yet. Without this a message typed mid-turn vanishes for a minute and then
 * appears, which looks like the app losing it and then finding it again.
 */
export function Queue({ items }: { items: QueuedItem[] }) {
  if (!items.length) return null;

  return (
    <div className="queue">
      <p className="queue-head">{items.length} queued, run when the agent finishes</p>
      <ol className="queue-list">
        {items.map((item, index) => (
          <li key={item.id} className={index === 0 ? 'queue-item next' : 'queue-item'}>
            {/* Which one goes next is the only ordering anyone needs to see. */}
            <span className="queue-position">{index === 0 ? 'Next' : index + 1}</span>
            {/* A queued command is not a message, and reads as one without saying so. */}
            <span className={item.kind === 'message' ? 'queue-text' : 'queue-text command'}>{item.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}