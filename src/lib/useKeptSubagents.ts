import { useCallback, useState } from 'react';

import { read as readStore, save } from './store';

/** Where kept tasks live, beside the marks the sidebar already remembers. */
const KEY = 'keptSubagents';

/**
 * Enough to offer a task again after a restart, which is all a kept one needs.
 *
 * Not its events. Those are in the session's log and are read back when it is opened, which
 * is what makes keeping one affordable at all (#178): a kept task costs a name and two ids
 * rather than the megabytes its work comes to.
 */
export interface KeptSubagent {
  agentId: string;
  sessionId: string;
  name: string;
  outcome?: 'completed' | 'failed';
}

function isKept(value: unknown): value is KeptSubagent {
  const entry = value as Partial<KeptSubagent> | null;
  return (
    typeof entry?.agentId === 'string' && typeof entry.sessionId === 'string' && typeof entry.name === 'string'
  );
}

function read(): KeptSubagent[] {
  try {
    const parsed: unknown = JSON.parse(readStore('sessions', KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isKept) : [];
  } catch {
    return [];
  }
}

/**
 * The delegated tasks a reader asked to keep (#180).
 *
 * The list ages tasks out a few prompts after they finish, which is right for the common
 * case and wrong for the one that matters most: a long audit or a research task is exactly
 * the one worth returning to an hour later, and it is the first to go because the
 * conversation carried on without it.
 *
 * Kept across restarts, because a task worth keeping for an hour is worth keeping over
 * lunch. That is only honest for work the log has been shown to hold - anything else would
 * come back as a row that opens onto nothing - so keeping one is offered once it has been
 * handed over, and what is written down is what it takes to ask for it again.
 */
export function useKeptSubagents() {
  const [kept, setKept] = useState<KeptSubagent[]>(read);

  const write = useCallback((next: KeptSubagent[]) => {
    save('sessions', KEY, JSON.stringify(next));
    setKept(next);
  }, []);

  /** Keep a task, or let a kept one go. */
  const toggle = useCallback(
    (entry: KeptSubagent) => {
      const current = read();
      const already = current.some((each) => each.agentId === entry.agentId);

      write(already ? current.filter((each) => each.agentId !== entry.agentId) : [...current, entry]);
    },
    [write],
  );

  /** Let one go by name alone, for a reader who dismisses it rather than unkeeping it. */
  const drop = useCallback(
    (agentId: string) => {
      const current = read();
      if (!current.some((entry) => entry.agentId === agentId)) return;

      write(current.filter((entry) => entry.agentId !== agentId));
    },
    [write],
  );

  /** Let go of everything belonging to sessions that no longer exist. */
  const dropSessions = useCallback(
    (sessionIds: readonly string[]) => {
      const going = new Set(sessionIds);
      const current = read();
      if (!current.some((entry) => going.has(entry.sessionId))) return;

      write(current.filter((entry) => !going.has(entry.sessionId)));
    },
    [write],
  );

  return {
    kept,
    toggle,
    drop,
    dropSessions,
    isKept: (agentId: string) => kept.some((entry) => entry.agentId === agentId),
  };
}
