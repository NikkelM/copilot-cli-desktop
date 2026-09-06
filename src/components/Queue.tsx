import type { QueuedMessage } from '../lib/useQueue';

/**
 * The messages waiting behind the turn that is running.
 *
 * Shown between the transcript and the composer, where they read as what they are: written
 * but not said yet. Without this a message typed mid-turn vanishes for a minute and then
 * appears, which looks like the app losing it and then finding it again.
 */
export function Queue({ messages }: { messages: QueuedMessage[] }) {
  if (!messages.length) return null;

  return (
    <div className="queue">
      <p className="queue-head">
        {messages.length} queued, sent when the agent finishes
      </p>
      <ol className="queue-list">
        {messages.map((message, index) => (
          <li key={message.id} className={index === 0 ? 'queue-item next' : 'queue-item'}>
            {/* Which one goes next is the only ordering anyone needs to see. */}
            <span className="queue-position">{index === 0 ? 'Next' : index + 1}</span>
            <span className="queue-text">{message.prompt}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
