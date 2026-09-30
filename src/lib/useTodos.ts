import { useCallback, useEffect, useRef, useState } from 'react';

import type { Todo } from '../../shared/protocol';
import { sessionTodos } from './sidecar';

/**
 * How long to wait after a change before asking what the list now says.
 *
 * The runtime announces every write to the table, and planning a piece of work writes a
 * row per todo in a burst - so a plan of a dozen items announces itself a dozen times in
 * as many milliseconds. The SDK says as much where it declares the event: clients can
 * debounce on arrival. Short enough that the list is drawn while the agent is still saying
 * what it intends, long enough that a burst costs one read.
 */
const SETTLE_MS = 150;

/**
 * The agent's own todo list, for the session being looked at (#172).
 *
 * Asked for rather than replayed. The event that announces a change carries no payload and
 * is ephemeral - it never reaches the log - so the only account of the list is the running
 * session's own database, and the only way to have it is to ask.
 *
 * Empty for a session that is not loaded, and nothing here resumes one. A todo list is
 * something a reader would like to see rather than something they asked for, and this app
 * does not start a process for that.
 *
 * @param sessionId the session being looked at, or null
 * @param loaded whether it is in memory, since a cold one has nothing to answer with
 */
export function useTodos(sessionId: string | null, loaded: boolean) {
  const [todos, setTodos] = useState<Todo[]>([]);

  /** Which session the list on hand belongs to, so a late answer cannot land on another. */
  const asking = useRef<string | null>(null);
  asking.current = sessionId;

  const read = useCallback(() => {
    const forSession = sessionId;
    if (!forSession || !loaded) {
      setTodos([]);
      return;
    }

    void sessionTodos(forSession)
      .then((found) => {
        // The reader moved on while this was in flight. Another session's list is worse
        // than none: it would be read as this one's.
        if (asking.current === forSession) setTodos(found);
      })
      // A list that cannot be read is shown as no list. It is the agent's account of its
      // own work, not a record of anything, and interrupting a reader over it would cost
      // more than the thing is worth.
      .catch(() => {
        if (asking.current === forSession) setTodos([]);
      });
  }, [sessionId, loaded]);

  // On arriving at a session and on its coming into memory, which is when there is first
  // something to ask.
  useEffect(read, [read]);

  const settling = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (settling.current && clearTimeout(settling.current)), []);

  /** Told that the table was written to, which says nothing about what it now holds. */
  const changed = useCallback(() => {
    if (settling.current) clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      settling.current = null;
      read();
    }, SETTLE_MS);
  }, [read]);

  return { todos, changed };
}
