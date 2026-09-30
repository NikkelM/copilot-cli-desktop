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
 * Read from the session's database on disk, so a session nobody has woken still has a
 * list. The runtime offers this over its own API, but only for a loaded session - and this
 * app loads nothing until asked, which would have meant an empty list for every session in
 * the sidebar until the moment it was worked in.
 *
 * Read again when the runtime says the table was written to. That event carries no payload
 * and is ephemeral, so it is a prompt to look rather than anything to apply.
 *
 * @param sessionId the session being looked at, or null
 */
export function useTodos(sessionId: string | null) {
  const [todos, setTodos] = useState<Todo[]>([]);

  /** Which session the list on hand belongs to, so a late answer cannot land on another. */
  const asking = useRef<string | null>(null);
  asking.current = sessionId;

  const read = useCallback(() => {
    const forSession = sessionId;
    if (!forSession) {
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
  }, [sessionId]);

  // On arriving at a session, which is when there is first something to ask about.
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
