import { useLayoutEffect, useRef } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';

/** Longest tool output shown inline before truncation. */
const MAX_OUTPUT = 600;

/** Distance from the bottom still treated as "following along". */
const PIN_THRESHOLD_PX = 80;

interface Entry {
  /** Inline label for tool activity. Messages carry none; they are styled instead. */
  label: string | null;
  variant: string;
  body: string;
  mono: boolean;
}

/**
 * Turn a raw session event into a displayable entry, or null to hide it.
 *
 * Returning null matters as much as formatting: the stream carries bookkeeping
 * events, tool-request-only assistant messages, and permission requests that are
 * already represented elsewhere in the UI.
 */
function toEntry(event: TranscriptEvent): Entry | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value.trim() ? value : null;
  };

  switch (event.type) {
    case 'user.message': {
      const content = str('content');
      return content ? { label: null, variant: 'user', body: content, mono: false } : null;
    }

    case 'assistant.message': {
      // An assistant message carrying only tool requests has empty content; the tool
      // itself is shown by its own execution events.
      const content = str('content');
      return content ? { label: null, variant: 'assistant', body: content, mono: false } : null;
    }

    case 'tool.execution_start': {
      const name = str('toolName') ?? str('mcpToolName') ?? 'tool';
      // The command and its human summary live in the tool arguments; shellToolInfo
      // carries path metadata rather than the command itself.
      const args = data.arguments as { command?: unknown; description?: unknown } | undefined;
      const command = typeof args?.command === 'string' ? args.command : null;
      const description = typeof args?.description === 'string' ? args.description : null;

      // The description often just restates the command, so only show it when it adds something.
      const redundant =
        description !== null && command !== null && description.toLowerCase() === command.toLowerCase();

      return {
        label: description && !redundant ? `${name} · ${description}` : name,
        variant: 'tool',
        body: command ?? '',
        mono: true,
      };
    }

    case 'tool.execution_complete': {
      if (data.success === true) {
        const result = data.result as { content?: unknown } | undefined;
        const content = typeof result?.content === 'string' ? result.content : '';
        const body = clip(content);
        // A silent success needs no row of its own; the command above already showed it ran.
        return body ? { label: null, variant: 'result', body, mono: true } : null;
      }
      const error = data.error as { message?: unknown } | undefined;
      const message = typeof error?.message === 'string' ? error.message : 'Tool failed';
      return { label: null, variant: 'failed', body: message, mono: true };
    }

    case 'session.error':
      return { label: 'Error', variant: 'failed', body: str('message') ?? 'Session error', mono: true };

    // permission.requested is deliberately absent: the approval panel above the
    // composer already shows it, and its payload is large and unreadable inline.
    default:
      return null;
  }
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_OUTPUT ? `${trimmed.slice(0, MAX_OUTPUT)}…` : trimmed;
}

interface TranscriptProps {
  events: TranscriptEvent[];
  showRaw: boolean;
  /** Changing this jumps to the newest message rather than preserving scroll. */
  sessionId: string;
}

export function Transcript({ events, showRaw, sessionId }: TranscriptProps) {
  // Raw mode keeps the unfiltered stream available for debugging, including the
  // events and fields the normal view deliberately drops.
  const entries: Entry[] = showRaw
    ? events.map((event) => ({
        label: event.type,
        variant: 'other',
        body: JSON.stringify(event.data ?? {}),
        mono: true,
      }))
    : events.map(toEntry).filter((entry): entry is Entry => entry !== null);

  const listRef = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);

  // Selecting a session re-pins to the bottom. The transcript itself arrives a moment
  // later, so the actual scroll happens in the effect below once content exists.
  useLayoutEffect(() => {
    pinned.current = true;
  }, [sessionId]);

  // Keep the newest entry in view while the user is following along, both for the
  // initial load and for streamed events. useLayoutEffect runs before paint, so a long
  // history never flashes at the top before jumping down.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && pinned.current) list.scrollTop = list.scrollHeight;
  }, [entries.length, sessionId]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    pinned.current = distance <= PIN_THRESHOLD_PX;
  }

  return (
    <ol className="transcript" ref={listRef} onScroll={onScroll}>
      {entries.map((entry, index) => (
        <li key={index} className={`entry ${entry.variant}`}>
          {entry.label && <span className="entry-label">{entry.label}</span>}
          {entry.body && <div className={`entry-body${entry.mono ? ' mono' : ''}`}>{entry.body}</div>}
        </li>
      ))}
    </ol>
  );
}
