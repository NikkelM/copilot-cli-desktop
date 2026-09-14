import { useCallback, useEffect, useRef, useState } from 'react';

import { deselectAgent, listAgents, selectAgent, sessionAgent } from './sidecar';
import type { AgentSummary, SessionAgent, TranscriptEvent } from '../../shared/protocol';

/**
 * Which agent a session is on, the means to change it, and the agents to change it to.
 *
 * The current agent is read from the session's log rather than from the runtime, so a
 * session that is not loaded can still say what it is set to. Changing it does cost a
 * resume, because the choice belongs to the running session; that is the same price as
 * sending, and nobody picks an agent except to use it.
 *
 * Deliberately not remembered between runs, unlike the model catalogue. Agents are files
 * the reader writes and deletes themselves, so a remembered list would offer agents that no
 * longer exist and hide ones just written. It is cheap enough to ask each time the picker is
 * opened, and only then.
 */
export function useAgent(sessionId: string | null, cwd: string | null, onError: (message: string) => void) {
  /** Undefined until the log has been read: not yet known is not the same as the default. */
  const [current, setCurrent] = useState<SessionAgent | null | undefined>(undefined);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const showing = useRef(sessionId);
  showing.current = sessionId;
  const report = useRef(onError);
  report.current = onError;
  /** Set while a fetch is in flight, so opening the picker repeatedly asks once. */
  const asking = useRef(false);

  useEffect(() => {
    setCurrent(undefined);
    if (!sessionId) return;

    sessionAgent(sessionId)
      .then((found) => showing.current === sessionId && setCurrent(found))
      .catch(() => showing.current === sessionId && setCurrent(null));
  }, [sessionId]);

  /**
   * Follow a change the runtime reports.
   *
   * Keeps the header right when a session is switched from a terminal, or when an agent is
   * chosen by a slash command rather than by this picker.
   */
  const observe = useCallback((event: TranscriptEvent) => {
    if (event.type === 'subagent.deselected') {
      setCurrent(null);
      return;
    }
    if (event.type !== 'subagent.selected') return;

    const data = (event.data ?? {}) as { agentName?: string; agentDisplayName?: string };
    if (data.agentName) setCurrent({ name: data.agentName, displayName: data.agentDisplayName ?? data.agentName });
  }, []);

  /**
   * Choose an agent, or the default when given nothing.
   *
   * Shown as chosen at once: switching resumes the session, which takes seconds, and the
   * runtime's own event replaces this when it arrives.
   */
  const choose = useCallback((agent: AgentSummary | null) => {
    const forSession = showing.current;
    if (!forSession) return;

    setCurrent(agent && { name: agent.name, displayName: agent.displayName });
    const done = agent ? selectAgent(forSession, agent.name) : deselectAgent(forSession);
    done.catch((e: unknown) => report.current(String(e)));
  }, []);

  /** Ask which agents exist, which is what starting the shared server is for. */
  const refresh = useCallback(() => {
    if (asking.current) return;
    asking.current = true;
    setFailed(null);

    listAgents(cwd ?? undefined)
      // Only the ones a reader may pick: the rest exist to be spawned by other agents, and
      // offering them would be offering something that does nothing.
      .then((found) => setAgents(found.filter((agent) => agent.userInvocable)))
      .catch((e: unknown) => setFailed(String(e)))
      .finally(() => (asking.current = false));
  }, [cwd]);

  // What a project defines is part of the answer, so an answer gathered elsewhere is not
  // this session's. Dropped rather than refetched, since nobody may open the picker at all.
  useEffect(() => setAgents(null), [cwd]);

  return { current, agents, failed, observe, choose, refresh };
}
