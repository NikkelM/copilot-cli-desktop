import { useLayoutEffect, useRef, useState } from 'react';

import type { TranscriptEvent } from '../../shared/protocol';
import { relativise } from '../lib/paths';

/** Longest tool output kept for the expanded view. */
const MAX_OUTPUT = 4000;

/** Distance from the bottom still treated as "following along". */
const PIN_THRESHOLD_PX = 80;

/** How close to the top triggers loading the previous page. */
const LOAD_OLDER_THRESHOLD_PX = 120;

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
  /** The subject is a question put to the user, so the answer completes it. */
  question?: boolean;
  /** What the user chose, shown beside the question rather than hidden in the output. */
  answer?: string;
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

/** Longest question shown in a row header before clamping. */
const MAX_HEADER = 140;

function clipLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_HEADER ? `${flat.slice(0, MAX_HEADER - 1)}…` : flat;
}

/**
 * The answer the user gave, pulled out of the tool's own result text.
 * The CLI reports it as "User responded: <answer>", and an unanswered question leaves
 * that empty rather than omitting the line.
 */
function answerOf(result: string): string | null {
  const match = /^\s*User responded:\s*([\s\S]*)$/.exec(result);
  const answer = match?.[1]?.trim();
  return answer ? clipLine(answer) : null;
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

        // The question is the subject of the row, the way a command is for a shell call.
        // The two ask_user variants disagree on the field: legacy sends "question",
        // elicitation sends "message".
        const question =
          name === 'ask_user'
            ? [args?.question, args?.message].find((v): v is string => typeof v === 'string' && v.trim() !== '')
            : undefined;

        const entry: ToolEntry = question
          ? { kind: 'tool', name, summary: clipLine(question), output: null, status: 'running', question: true }
          : { kind: 'tool', name, summary: summarise(args, cwd), output: null, status: 'running' };

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

          // Answering a question is the outcome, so it belongs in the header rather than
          // hidden behind an expander nobody would think to open. It carries its own
          // styling instead of punctuation, since questions already end in a question mark.
          const answer = entry.question && succeeded ? answerOf(output) : null;
          if (answer) entry.answer = answer;
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
  const lines = entry.output ? entry.output.split('\n').length : 0;

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
        <span className="tool-subject">
          <span className="tool-summary">{entry.summary}</span>
          {entry.answer && <span className="tool-answer">{entry.answer}</span>}
        </span>
        {entry.status === 'cancelled' && <span className="tool-note">interrupted</span>}
        {/* Doubles as the affordance that the row opens, and says how much is behind it.
            Right-aligned, so it reads as a separate column without needing punctuation. */}
        {expandable && !open && (
          <span className="tool-lines">{`${lines} ${lines === 1 ? 'line' : 'lines'}`}</span>
        )}
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
  /** Whether older history exists before the events supplied. */
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

export function Transcript({
  events,
  sessionId,
  cwd,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: TranscriptProps) {
  const entries = toEntries(events, cwd);
  const listRef = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  /** Scroll height before older events were prepended, so the view can be held still. */
  const restoreFrom = useRef<number | null>(null);

  // Selecting a session re-pins to the bottom. The transcript itself arrives a moment
  // later, so the actual scroll happens in the effect below once content exists.
  useLayoutEffect(() => {
    pinned.current = true;
    restoreFrom.current = null;
  }, [sessionId]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    // Older events were prepended: keep the reader where they were rather than letting
    // the added height push their position away.
    if (restoreFrom.current !== null) {
      list.scrollTop += list.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
      return;
    }

    // Otherwise follow the newest entry while the user is at the bottom, for both the
    // initial load and streamed events. useLayoutEffect runs before paint, so a long
    // history never flashes at the top before jumping down.
    if (pinned.current) list.scrollTop = list.scrollHeight;
  }, [entries.length, sessionId]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;

    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    pinned.current = distance <= PIN_THRESHOLD_PX;

    if (list.scrollTop <= LOAD_OLDER_THRESHOLD_PX && hasOlder && !loadingOlder) {
      restoreFrom.current = list.scrollHeight;
      onLoadOlder();
    }
  }

  return (
    <ol className="transcript" ref={listRef} onScroll={onScroll}>
      <li className="history-edge">
        {loadingOlder ? 'Loading earlier messages…' : hasOlder ? 'Scroll up for earlier messages' : 'Start of session'}
      </li>
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
