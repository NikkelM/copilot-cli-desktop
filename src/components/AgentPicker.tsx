import { useEffect, useRef, useState } from 'react';

import type { AgentSummary, SessionAgent } from '../../shared/protocol';

interface AgentPickerProps {
  /** What the session is on: null for the default agent, undefined until its log is read. */
  current: SessionAgent | null | undefined;
  /** What is available, or null until it has been asked for. */
  agents: AgentSummary[] | null;
  /** Why the agents could not be listed, if they could not. */
  failed: string | null;
  /** Ask which agents exist. Costs a running server, so it waits for the picker to open. */
  onOpen: () => void;
  /** Null is the default agent, which is a choice like any other. */
  onChoose: (agent: AgentSummary | null) => void;
}

/**
 * Which custom agent a session's next turns run as.
 *
 * Beside the model because it is the same kind of setting: a fact about the session worth
 * seeing at a glance, changed rarely, and read from the session's own log so it is known
 * before anything is started.
 */
export function AgentPicker({ current, agents, failed, onOpen, onChoose }: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);

    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }

    setOpen(true);
    // Asking costs a server process, so it waits for someone to actually want the list.
    onOpen();
  }

  function pick(agent: AgentSummary | null) {
    onChoose(agent);
    setOpen(false);
  }

  return (
    <div className="agent" ref={box}>
      <button
        type="button"
        className="agent-current"
        onClick={toggle}
        title="Change the agent for this session"
      >
        {/* Holds its shape while the log is being read rather than naming an agent that the
            read may contradict, the same way the model control does. */}
        {current === undefined ? (
          <span className="agent-name waiting" aria-label="Loading agent" />
        ) : (
          <span className={current ? 'agent-name' : 'agent-name default'}>{current?.displayName ?? 'Default'}</span>
        )}
      </button>

      {open && (
        <div className="agent-menu" role="listbox">
          {failed && <p className="error">{failed}</p>}
          {!agents && !failed && <p className="agent-loading">Starting the runtime to ask what is available.</p>}

          {/* Always offered, and offered first: it is where every session starts, so it is
              the way back from a choice rather than a choice that has to be found. */}
          <button
            type="button"
            role="option"
            aria-selected={!current}
            className={current ? 'agent-row' : 'agent-row chosen'}
            onClick={() => pick(null)}
          >
            <span className="agent-row-name">Default</span>
            <span className="agent-row-description">Copilot itself, with no agent in front of it</span>
          </button>

          {group(agents ?? []).map(([source, found]) => (
            <div key={source}>
              <p className="agent-group-head">{source}</p>
              {found.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  role="option"
                  aria-selected={current?.name === agent.name}
                  className={current?.name === agent.name ? 'agent-row chosen' : 'agent-row'}
                  onClick={() => pick(agent)}
                >
                  <span className="agent-row-name">
                    {agent.displayName}
                    {/* An agent that pins a model overrides the model picker for its turns,
                        so saying which one is the difference between the header being right
                        and the header being misleading. */}
                    {agent.model && <span className="agent-row-model">{agent.model}</span>}
                  </span>
                  <span className="agent-row-description">{agent.description}</span>
                </button>
              ))}
            </div>
          ))}

          {agents?.length === 0 && (
            <p className="agent-loading">No custom agents found. Files in ~/.copilot/agents appear here.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Agents by where they came from, the reader's own first.
 *
 * Source is the one thing that tells a reader whether an agent is theirs to change, so it
 * sorts the list rather than being a note on each row. Anything that is not the reader's own
 * keeps the order it arrived in, since there is nothing to prefer between plugins.
 */
function group(agents: AgentSummary[]): Array<[string, AgentSummary[]]> {
  const bySource = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const found = bySource.get(agent.source);
    if (found) found.push(agent);
    else bySource.set(agent.source, [agent]);
  }

  return [...bySource.entries()].sort(([a], [b]) => (a === 'user' ? -1 : b === 'user' ? 1 : 0));
}
