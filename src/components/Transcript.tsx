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

interface TranscriptProps {
  events: TranscriptEvent[];
  showRaw: boolean;
}

export function Transcript({ events, showRaw }: TranscriptProps) {
  const visible = showRaw ? events : events.filter(isRendered);

  return (
    <ol className="transcript">
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
