import { useLayoutEffect, useRef, useState } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';
import { relativise } from '../lib/paths';

/** Longest tool output kept for the expanded view. */
const MAX_OUTPUT = 4000;

/** Distance from the bottom still treated as "following along". */
const PIN_THRESHOLD_PX = 80;

export interface MessageEntry {
  kind: 'message';
  variant: 'user' | 'assistant' | 'failed';
  body: string;
}

/**
 * One tool invocation, pairing its start with its completion.
 * Kept as a single unit so the command, its status and its output collapse together.
 */
export interface ToolEntry {
  kind: 'tool';
  name: string;
  /** One line summarising what ran, shown while collapsed. */
  summary: string;
  output: string | null;
  status: 'running' | 'ok' | 'failed' | 'cancelled';
}

export type Entry = MessageEntry | ToolEntry;

function text(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Argument keys worth showing as a tool's one-line summary, most specific first.
 *
 * Chosen from the tools that actually appear in real sessions: `command` for shells,
 * `path` for file operations, `pattern` for searches, and so on. Without this a
 * `create` call shows only the word "create" with no indication of what it wrote.
 */
const SUMMARY_KEYS = [
  'command',
  'path',
  'pattern',
  'query',
  'url',
  'name',
  'menu_path',
  'skill',
  'intent',
  'message',
  'description',
  'action',
];

function summarise(args: Record<string, unknown> | undefined, cwd: string | null): string {
  if (!args) return '';

  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return key === 'path' ? relativise(value, cwd) : value;
    }
  }
  return '';
}

function clip(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_OUTPUT ? `${trimmed.slice(0, MAX_OUTPUT)}…` : trimmed;
}

/**
 * Build the displayable timeline from raw session events.
 *
 * Tool starts and completions arrive as separate events but describe one action, so
 * they are paired by `toolCallId` into a single entry. Anything not handled here is
 * invisible, so new event types need a case rather than a fallback.
 */
export function toEntries(events: TranscriptEvent[], cwd: string | null): Entry[] {
  const entries: Entry[] = [];
  /** In-flight tool calls, so a completion can fill in the entry it belongs to. */
  const pending = new Map<string, ToolEntry>();

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;

    switch (event.type) {
      case 'user.message': {
        const content = text(data, 'content');
        if (content) entries.push({ kind: 'message', variant: 'user', body: content });
        break;
      }

      case 'assistant.message': {
        // An assistant message carrying only tool requests has empty content; the tool
        // itself is shown by its own entry.
        const content = text(data, 'content');
        if (content) entries.push({ kind: 'message', variant: 'assistant', body: content });
        break;
      }

      case 'tool.execution_start': {
        const name = text(data, 'toolName') ?? text(data, 'mcpToolName') ?? 'tool';
        // The command, path or query lives in the tool arguments; shellToolInfo carries
        // path metadata rather than anything worth summarising.
        const args = data.arguments as Record<string, unknown> | undefined;

        const entry: ToolEntry = {
          kind: 'tool',
          name,
          summary: summarise(args, cwd),
          output: null,
          status: 'running',
        };

        const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
        if (id) pending.set(id, entry);
        entries.push(entry);
        break;
      }

      case 'tool.execution_complete': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
        const entry = id ? pending.get(id) : undefined;
        if (id) pending.delete(id);

        const succeeded = data.success === true;
        const result = data.result as { content?: unknown } | undefined;
        const error = data.error as { message?: unknown } | undefined;
        const output = succeeded
          ? typeof result?.content === 'string'
            ? clip(result.content)
            : ''
          : typeof error?.message === 'string'
            ? error.message
            : 'Tool failed';

        if (entry) {
          // Updating the entry already in the list keeps the tool as one visual unit.
          entry.status = succeeded ? 'ok' : 'failed';
          entry.output = output || null;
        } else {
          // A completion without its start, for example when replaying a truncated log.
          entries.push({
            kind: 'tool',
            name: 'tool',
            summary: '',
            output,
            status: succeeded ? 'ok' : 'failed',
          });
        }
        break;
      }

      case 'session.error':
        entries.push({
          kind: 'message',
          variant: 'failed',
          body: text(data, 'message') ?? 'Session error',
        });
        break;

      // An interrupted turn never emits tool.execution_complete, so anything still
      // pending when the session stops will never complete. Without this such a row
      // stays "running" forever, including on every later replay.
      //
      // An abort emits `abort` then `assistant.turn_end`, with no `session.idle` at all,
      // so all three signals are needed rather than idle alone.
      case 'abort':
      case 'session.idle':
      case 'session.shutdown':
        for (const entry of pending.values()) entry.status = 'cancelled';
        pending.clear();
        break;

      // permission.requested is deliberately absent: the approval panel above the
      // composer already shows it, and its payload is large and unreadable inline.
      default:
        break;
    }
  }

  return entries;
}

const STATUS_GLYPH: Record<ToolEntry['status'], string> = {
  running: '·',
  ok: '✓',
  failed: '✕',
  cancelled: '⊘',
};

/** A single tool call, collapsed to one line until expanded. */
function ToolRow({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(entry.output);

  return (
    <div className={`tool ${entry.status}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((value) => !value)}
        disabled={!expandable}
        title={entry.status === 'cancelled' ? 'Interrupted before it finished' : undefined}
      >
        <span className="tool-status">{STATUS_GLYPH[entry.status]}</span>
        <span className="tool-name">{entry.name}</span>
        <span className="tool-summary">{entry.summary}</span>
        {entry.status === 'cancelled' && <span className="tool-note">interrupted</span>}
        {expandable && <span className="tool-chevron">{open ? '▾' : '▸'}</span>}
      </button>
      {open && entry.output && <pre className="tool-output">{entry.output}</pre>}
    </div>
  );
}

interface TranscriptProps {
  events: TranscriptEvent[];
  /** Changing this jumps to the newest message rather than preserving scroll. */
  sessionId: string;
  /** Used to shorten file paths in tool summaries. */
  cwd: string | null;
}

export function Transcript({ events, sessionId, cwd }: TranscriptProps) {
  const entries = toEntries(events, cwd);
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
        <li key={index} className="entry">
          {entry.kind === 'tool' ? (
            <ToolRow entry={entry} />
          ) : (
            <div className={`message ${entry.variant}`}>{entry.body}</div>
          )}
        </li>
      ))}
    </ol>
  );
}
