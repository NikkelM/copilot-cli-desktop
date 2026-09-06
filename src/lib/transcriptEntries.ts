import type { TranscriptEvent } from '../../shared/protocol';
import { relativise } from './paths';

/** Longest tool output kept for the expanded view. */
const MAX_OUTPUT = 4000;

export interface MessageEntry {
  kind: 'message';
  /** Identity of the source event, so rows survive history being prepended. */
  key: string;
  variant: 'user' | 'assistant' | 'failed' | 'stopped';
  body: string;
}

/**
 * The model's own account of how it got to an answer.
 *
 * Kept apart from the reply rather than shown above it, because it is usually longer than
 * the answer and is not what most readers came for. It rides on the assistant message
 * rather than arriving as its own event, which is why it survives into the log and can be
 * read again weeks later.
 */
export interface ReasoningEntry {
  kind: 'reasoning';
  key: string;
  body: string;
  /**
   * Arriving now rather than read back from the log.
   *
   * Shown open while it happens, because the wait before a reply is the longest the window
   * is ever silent and this is the only thing that fills it. A session opened later shows
   * its thinking closed instead: the reader came for the work, not to re-read the thinking
   * behind every reply in it.
   */
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
  /**
   * What actually ran, in full. The header shows the agent's description of it and
   * truncates, so without this the command itself has nowhere to be read.
   */
  command?: string;
  /**
   * The change a file tool made, as it reported it.
   *
   * Read from the log rather than computed, so a session opened weeks later shows the
   * same change it showed when it happened, wherever the file was and whether or not it
   * is still there.
   */
  patch?: string;
  /** A search, whose result is counted in matches rather than lines. */
  search?: boolean;
}

export type Entry = MessageEntry | ReasoningEntry | ToolEntry;

function text(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Why a turn stopped, in the reader's terms.
 *
 * Said plainly rather than in the passive: a turn the reader stopped and a turn something
 * else stopped look identical once the reply has ended, and which it was is the whole
 * content of the row.
 */
function stopReason(data: Record<string, unknown>): string {
  switch (data.reason) {
    case 'user_initiated':
      return 'Cancelled by user';
    case 'remote_command':
      return 'Stopped by a remote command';
    case 'user_abort':
      return 'Stopped by a connected server';
    case 'autopilot_credit_limit':
      return 'Stopped: this run reached its credit limit';
    default:
      return 'Stopped';
  }
}

/** The message an event belongs to, so its deltas and its finished form share a row. */
function messageKey(data: Record<string, unknown>, fallback: string): string {
  return typeof data.messageId === 'string' ? data.messageId : fallback;
}

/**
 * What to call a tool, where its own name is an implementation detail.
 *
 * The CLI names a few itself, on the event, and those are used as they come. The rest
 * arrive blank and are named here. ask_user is listed even though the CLI does name it,
 * so the row reads the same whether or not the event carried a title - the alternative
 * is a tool that changes name depending on which path found it.
 */
const DISPLAY_NAMES: Record<string, string> = {
  ask_user: 'Asking user',
  powershell: 'Shell',
  bash: 'Shell',
  grep: 'Search',
  rg: 'Search',
};

function displayName(name: string, data: Record<string, unknown>): string {
  return text(data, 'toolTitle') ?? DISPLAY_NAMES[name] ?? name;
}

/**
 * Argument keys worth showing as a tool's one-line summary, most specific first.
 *
 * `description` leads: it is the agent's own account of what it is doing, which reads
 * better than the command implementing it and is what the CLI shows. The rest are chosen
 * from the tools that appear in real sessions - `path` for file operations, `pattern` for
 * searches - since without them a `create` call shows only the word "create".
 */
const SUMMARY_KEYS = [
  'description',
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
  'action',
];

function summarise(args: Record<string, unknown> | undefined, cwd: string | null): string {
  if (!args) return '';

  // A search is two things: what was looked for and where. Showing only the pattern gives
  // the same row for the same search over different trees, and quoting marks out where a
  // pattern with spaces in it starts and ends.
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern : null;
  if (pattern) {
    const where = pathList(args.paths, cwd);
    return where ? `"${pattern}" (${where})` : `"${pattern}"`;
  }

  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return key === 'path' ? relativise(value, cwd) : value;
    }
  }
  return '';
}

/** Where a search looked, relative to the session's directory. Accepts one path or many. */
function pathList(value: unknown, cwd: string | null): string | null {
  const given = Array.isArray(value) ? value : [value];
  const paths = given
    .filter((path): path is string => typeof path === 'string' && path.trim() !== '')
    .map((path) => relativise(path, cwd));

  return paths.length > 0 ? paths.join(', ') : null;
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
  /** Thinking already shown as it was written, so the message repeating it is skipped. */
  const streamed = new Set<string>();
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
        // Thinking comes before the answer it produced, as it happened. Skipped when it
        // already arrived as it was written: the message repeats it at the end of a turn,
        // and showing it twice would be worse than not showing it at all.
        const reasoning = text(data, 'reasoningText');
        if (reasoning && !streamed.has(reasoning.trim())) {
          entries.push({ kind: 'reasoning', key: `${messageKey(data, key)}-why`, body: reasoning });
        }
        // Keyed by the message rather than the event, so the finished reply lands on the
        // row its own deltas were already drawing instead of replacing it.
        if (content) entries.push({ kind: 'message', key: messageKey(data, key), variant: 'assistant', body: content });
        break;
      }

      /**
       * Thinking as it is written. Only ever seen live - these are ephemeral and never
       * reach the log, which is why a replayed session gets its thinking from the message
       * instead.
       */
      case 'assistant.reasoning':
      case 'assistant.reasoning_delta': {
        const content = text(data, 'deltaContent') ?? text(data, 'content');
        if (!content) break;

        const id = typeof data.reasoningId === 'string' ? data.reasoningId : key;
        streamed.add(content.trim());
        entries.push({ kind: 'reasoning', key: id, body: content, streaming: true });
        break;
      }

      // A reply as it is being written. Only ever seen live: these are ephemeral and
      // never reach the log, so replaying a session shows the finished message instead.
      case 'assistant.message_delta': {
        const content = text(data, 'deltaContent');
        if (content) entries.push({ kind: 'message', key: messageKey(data, key), variant: 'assistant', body: content });
        break;
      }

      case 'tool.execution_start': {
        const name = text(data, 'toolName') ?? text(data, 'mcpToolName') ?? 'tool';
        // The command, path or query lives in the tool arguments; shellToolInfo carries
        // path metadata rather than anything worth summarising.
        const args = data.arguments as Record<string, unknown> | undefined;
        const label = displayName(name, data);
        const command = typeof args?.command === 'string' && args.command.trim() ? args.command : undefined;
        const search = typeof args?.pattern === 'string' && args.pattern.trim() !== '';

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
              name: label,
              summary: clipLine(question),
              output: null,
              status: 'running',
              question: true,
              choices: Array.isArray(args?.choices)
                ? args.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
                : undefined,
            }
          : {
              kind: 'tool',
              key,
              name: label,
              summary: clipLine(summarise(args, cwd)),
              output: null,
              status: 'running',
              command,
              search: search || undefined,
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
        const result = data.result as { content?: unknown; detailedContent?: unknown } | undefined;
        const error = data.error as { message?: unknown } | undefined;
        const output = succeeded
          ? typeof result?.content === 'string'
            ? clip(result.content)
            : ''
          : typeof error?.message === 'string'
            ? error.message
            : 'Tool failed';

        // A file tool reports the change it made as a unified diff, which is worth far
        // more than the sentence saying it succeeded.
        const detail = result?.detailedContent;
        const patch = typeof detail === 'string' && detail.includes('diff --git') ? detail : undefined;

        if (entry) {
          // Updating the entry already in the list keeps the tool as one visual unit.
          entry.status = succeeded ? 'ok' : 'failed';
          entry.output = output || null;
          entry.patch = patch;

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
            patch,
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
        // A reply that simply stops mid-sentence reads as the app losing the thread. The
        // event is written to the log, so this says so on every later replay too.
        entries.push({ kind: 'message', key, variant: 'stopped', body: stopReason(data) });
        for (const entry of pending.values()) entry.status = 'cancelled';
        pending.clear();
        break;

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

  if (a.kind === 'reasoning') {
    const other = b as ReasoningEntry;
    return a.body === other.body && a.streaming === other.streaming;
  }

  if (a.kind === 'message') {
    const other = b as MessageEntry;
    return a.variant === other.variant && a.body === other.body;
  }

  const other = b as ToolEntry;
  return (
    a.name === other.name &&
    a.summary === other.summary &&
    a.output === other.output &&
    a.status === other.status &&
    a.answer === other.answer &&
    a.command === other.command &&
    a.patch === other.patch &&
    a.search === other.search &&
    sameChoices(a.choices, other.choices)
  );
}

function sameChoices(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((choice, index) => choice === b[index]);
}
