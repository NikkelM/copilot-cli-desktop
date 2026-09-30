import { useCallback, useEffect, useRef, useState } from 'react';

import type { DelegatedTask } from '../../shared/protocol';
import { sessionAgents } from '../lib/sidecar';
import { explain } from '../lib/errors';

/** How long ago, in the shortest form that is still true. */
function since(at: string): string {
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

/** What a finished task came to, for a row that has not been opened. */
function cost(task: DelegatedTask): string {
  const parts: string[] = [];
  if (task.toolCalls !== undefined) parts.push(`${task.toolCalls} tool ${task.toolCalls === 1 ? 'call' : 'calls'}`);
  if (task.tokens !== undefined) parts.push(`${Math.round(task.tokens / 1000)}k tokens`);
  if (task.durationMs !== undefined) parts.push(`${Math.round(task.durationMs / 1000)}s`);
  return parts.join(' · ');
}

/**
 * Every task a session delegated, to show or to keep (#228).
 *
 * The sidebar lists only what this app watched start, so a task hidden, one from a previous
 * run, and one from a session used in a terminal are all unreachable from it. They are in
 * the log, and this is where they are found.
 *
 * A page at a time, because finding every one means reading the whole log - seconds on the
 * largest here. A reader looking for a task they remember wants a recent one, so the first
 * page is nearly always the only one read.
 */
export function Subagents({
  sessionId,
  isShown,
  isKept,
  onToggleShown,
  onKeep,
  onOpen,
  onClose,
}: {
  sessionId: string;
  isShown: (agentId: string) => boolean;
  isKept: (agentId: string) => boolean;
  onToggleShown: (task: DelegatedTask) => void;
  onKeep: (task: DelegatedTask) => void;
  /** Read what a task did, which is the reason for finding it. */
  onOpen: (task: DelegatedTask) => void;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<DelegatedTask[]>([]);
  const [more, setMore] = useState<number | null>(null);
  const [reading, setReading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  /** Which session the answer on its way belongs to, so a late one cannot land on another. */
  const asked = useRef(0);

  // Closed the way every other panel is closed, which is the key a reader reaches for.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  useEffect(() => {
    asked.current += 1;
    const mine = asked.current;
    setTasks([]);
    setMore(null);
    setFailed(null);
    setReading(true);

    sessionAgents(sessionId)
      .then((page) => {
        if (mine !== asked.current) return;
        setTasks(page.agents);
        setMore(page.truncated ? page.nextBefore : null);
      })
      .catch((error: unknown) => mine === asked.current && setFailed(explain(error)))
      .finally(() => {
        if (mine === asked.current) setReading(false);
      });
  }, [sessionId]);

  const readMore = useCallback(() => {
    if (more === null) return;

    const mine = asked.current;
    setReading(true);
    sessionAgents(sessionId, undefined, more)
      .then((page) => {
        if (mine !== asked.current) return;
        // Appended rather than replaced: the pages are halves of one list, and the reader
        // asked for more of it rather than for a different one.
        setTasks((current) => [...current, ...page.agents]);
        setMore(page.truncated ? page.nextBefore : null);
      })
      .catch((error: unknown) => mine === asked.current && setFailed(explain(error)))
      .finally(() => {
        if (mine === asked.current) setReading(false);
      });
  }, [more, sessionId]);

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      {/* Stops a click inside the panel reaching the backdrop, which would close it. */}
      <div
        className="subagents"
        role="dialog"
        aria-modal="true"
        aria-label="Subagents"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="subagents-header">
          <h2>Subagents</h2>
          <button type="button" className="subagents-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {failed && <p className="error">{failed}</p>}

        {/* Said rather than left blank, because reading a large log takes a moment and a
            panel with nothing in it looks like a session that delegated nothing. */}
        {reading && tasks.length === 0 && <p className="subagents-note">Reading the conversation.</p>}

        {!reading && !failed && tasks.length === 0 && (
          <p className="subagents-note">This session has not delegated anything.</p>
        )}

        {tasks.length > 0 && (
          <ul className="subagents-list">
            {tasks.map((task) => (
              <li key={task.agentId} className="subagents-row">
                {/* Shown is about the sidebar now, kept is about surviving a restart. A kept
                    task cannot be un-shown, since keeping something unreachable means nothing. */}
                <label className="subagents-show">
                  <input
                    type="checkbox"
                    checked={isShown(task.agentId)}
                    disabled={isKept(task.agentId)}
                    onChange={() => onToggleShown(task)}
                  />
                  <span className="subagents-name">{task.name}</span>
                </label>

                <button
                  type="button"
                  className="subagents-open"
                  onClick={() => onOpen(task)}
                  aria-label={`Read what ${task.name} did`}
                  title={`Read what ${task.name} did`}
                >
                  <span className="subagents-when">{since(task.startedAt)}</span>
                  {task.outcome === 'failed' && <span className="subagents-failed">failed</span>}
                  {task.outcome === undefined && <span className="subagents-running">working</span>}
                  <span className="subagents-cost">{cost(task)}</span>
                </button>

                <button
                  type="button"
                  className={`subagents-keep${isKept(task.agentId) ? ' kept' : ''}`}
                  onClick={() => onKeep(task)}
                  title={isKept(task.agentId) ? `Stop keeping ${task.name}` : `Keep ${task.name}`}
                  aria-label={isKept(task.agentId) ? `Stop keeping ${task.name}` : `Keep ${task.name}`}
                  aria-pressed={isKept(task.agentId)}
                >
                  ★
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Offered rather than read, because the rest of a large log is seconds of reading
            and the task somebody is looking for is usually a recent one. */}
        {more !== null && (
          <button type="button" className="subagents-more" onClick={readMore} disabled={reading}>
            {reading ? 'Reading…' : 'Look further back'}
          </button>
        )}
      </div>
    </div>
  );
}
