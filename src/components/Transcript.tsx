import { useLayoutEffect, useRef } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';

/** Events worth showing. The stream also carries many internal model.* bookkeeping events. */
const RENDERED = new Set([
  'user.message',
  'assistant.message',
  'tool.execution_start',
  'tool.execution_complete',
  'session.error',
  'permission.requested',
]);

export function isRendered(event: TranscriptEvent): boolean {
  return RENDERED.has(event.type);
}

/** Distance from the bottom still treated as "following along". */
const PIN_THRESHOLD_PX = 80;

interface TranscriptProps {
  events: TranscriptEvent[];
  showRaw: boolean;
  /** Changing this jumps to the newest message rather than preserving scroll. */
  sessionId: string;
}

export function Transcript({ events, showRaw, sessionId }: TranscriptProps) {
  const visible = showRaw ? events : events.filter(isRendered);
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
  }, [visible.length, sessionId]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    pinned.current = distance <= PIN_THRESHOLD_PX;
  }

  return (
    <ol className="transcript" ref={listRef} onScroll={onScroll}>
      {visible.map((event, index) => (
        <li key={index} className={`entry ${entryClass(event.type)}`}>
          <span className="entry-role">{roleLabel(event.type)}</span>
          <div className="entry-body">{describe(event)}</div>
        </li>
      ))}
    </ol>
  );
}

function entryClass(type: string): string {
  if (type === 'user.message') return 'user';
  if (type === 'assistant.message') return 'assistant';
  if (type.startsWith('tool.')) return 'tool';
  if (type === 'session.error') return 'failed';
  return 'other';
}

function roleLabel(type: string): string {
  switch (type) {
    case 'user.message':
      return 'You';
    case 'assistant.message':
      return 'Copilot';
    case 'tool.execution_start':
      return 'Tool';
    case 'tool.execution_complete':
      return 'Result';
    case 'permission.requested':
      return 'Permission';
    case 'session.error':
      return 'Error';
    default:
      return type;
  }
}

/**
 * Extract displayable text without assuming a precise payload shape.
 * Event data varies by type and by CLI version, so this stays defensive; issue #8
 * replaces it with proper per-type rendering.
 */
function describe(event: TranscriptEvent): string {
  const data = event.data as Record<string, unknown> | null;
  if (!data) return '';

  for (const key of ['content', 'message', 'text', 'name', 'toolName']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value;
  }

  return JSON.stringify(data).slice(0, 400);
}
