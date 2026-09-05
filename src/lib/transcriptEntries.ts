import type { TranscriptEvent } from '../../shared/protocol';
import { relativise } from './paths';

/** Longest tool output kept for the expanded view. */
const MAX_OUTPUT = 4000;

export interface MessageEntry {
  kind: 'message';
  /** Identity of the source event, so rows survive history being prepended. */
  key: string;
  variant: 'user' | 'assistant' | 'failed';
  body: string;
  /** Still being written, so the row shows that more is coming. */
  streaming?: boolean;
}

/**
 * One tool invocation, pairing its start with its completion.
 * Kept as a single unit so the command, its status and its output collapse together.
 */
export interface ToolEntry {
  kind: 'tool';
  /** Identity of the start event, so rows survive history being prepended. */
  key: string;
  name: string;
  /** One line summarising what ran, shown while collapsed. */
  summary: string;
  output: string | null;
  status: 'running' | 'ok' | 'failed' | 'cancelled';
  /** The subject is a question put to the user, so the answer completes it. */
  question?: boolean;
  /** What the user chose, shown beside the question rather than hidden in the output. */
  answer?: string;
  /** The options offered, so expanding shows what was on the table, not just the pick. */
  choices?: string[];
}

export type Entry = MessageEntry | ToolEntry;

function text(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The message an event belongs to, so its deltas and its finished form share a row. */
function messageKey(data: Record<string, unknown>, fallback: string): string {
  return typeof data.messageId === 'string' ? data.messageId : fallback;
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
 * that empty rather than omitting the line. Kept whole so it can be matched against the
 * offered choices; the header relies on CSS to truncate it.
 */
function answerOf(result: string): string | null {
  const match = /^\s*User responded:\s*([\s\S]*)$/.exec(result);
  const answer = match?.[1]?.replace(/\s+/g, ' ').trim();
  return answer ? answer : null;
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
    // Position is not identity: loading older history prepends events and shifts every
    // index, which would hand a row's local state to a different entry.
    const key = event.id ?? `${event.type}:${entries.length}`;

    switch (event.type) {
      case 'user.message': {
        const content = text(data, 'content');
        if (content) entries.push({ kind: 'message', key, variant: 'user', body: content });
        break;
      }

      case 'assistant.message': {
        // An assistant message carrying only tool requests has empty content; the tool
        // itself is shown by its own entry.
        const content = text(data, 'content');
        // Keyed by the message rather than the event, so the finished reply lands on the
        // row its own deltas were already drawing instead of replacing it.
        if (content) entries.push({ kind: 'message', key: messageKey(data, key), variant: 'assistant', body: content });
        break;
      }

      // A reply as it is being written. Only ever seen live: these are ephemeral and
      // never reach the log, so replaying a session shows the finished message instead.
      case 'assistant.message_delta': {
        const content = text(data, 'deltaContent');
        if (content) {
          entries.push({
            kind: 'message',
            key: messageKey(data, key),
            variant: 'assistant',
            body: content,
            streaming: true,
          });
        }
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
          ? {
              kind: 'tool',
              key,
              name,
              summary: clipLine(question),
              output: null,
              status: 'running',
              question: true,
              choices: Array.isArray(args?.choices)
                ? args.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
                : undefined,
            }
          : { kind: 'tool', key, name, summary: summarise(args, cwd), output: null, status: 'running' };

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
            key,
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
          key,
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

/**
 * Whether two entries describe the same row in the same state.
 *
 * Compared field by field because the list is rebuilt on every render, so equal rows are
 * never the same object. Every field the row draws is included; anything left out would
 * leave the row showing something stale.
 */
export function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;

  if (a.kind === 'message') {
    const other = b as MessageEntry;
    return a.variant === other.variant && a.body === other.body && a.streaming === other.streaming;
  }

  const other = b as ToolEntry;
  return (
    a.name === other.name &&
    a.summary === other.summary &&
    a.output === other.output &&
    a.status === other.status &&
    a.answer === other.answer &&
    sameChoices(a.choices, other.choices)
  );
}

function sameChoices(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((choice, index) => choice === b[index]);
}
