import type { TranscriptEvent } from '../../shared/protocol';
import { stripAnsi } from '../../shared/ansi';
import { relativise } from './paths';

/** The three events that describe a delegation rather than the work inside it. */
const SUBAGENT_LIFECYCLE = new Set(['subagent.started', 'subagent.completed', 'subagent.failed']);

/** Longest tool output kept for the expanded view. */
const MAX_OUTPUT = 4000;

export interface MessageEntry {
  kind: 'message';
  /** Identity of the source event, so rows survive history being prepended. */
  key: string;
  variant: 'user' | 'assistant' | 'failed' | 'stopped' | 'command';
  body: string;
  /** When it was said. Absent only for an entry the app invented before the runtime spoke. */
  at?: string;
  /**
   * Shown as written, rather than parsed as markdown.
   *
   * Command output is laid out with spaces and newlines and means them: run through
   * markdown its columns collapse and its blank lines disappear. Set only when the runtime
   * says the text is not markdown, since some commands answer in it.
   */
  preformatted?: boolean;
  /** Still arriving, so anything that needs the whole of it should wait for the rest. */
  streaming?: boolean;
  /**
   * A reply that was cut off part way through.
   *
   * Worth saying: the text is what the agent had said when it was stopped, not what it
   * meant to say, and a transcript that presents the two alike is misleading about both.
   */
  partial?: boolean;
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
  /**
   * The file a file tool named, kept apart from the summary.
   *
   * The summary is whatever reads best and is not always the path - a tool that describes
   * itself wins over one that names a file - so the badge reads this instead of trying to
   * find an extension in a sentence.
   */
  path?: string;
  /** A search, whose result is counted in matches rather than lines. */
  search?: boolean;
  /**
   * Not a tool at all, but a skill that was loaded, and what caused it to load.
   *
   * Shares the row because it is the same shape: a named thing that ran, with content
   * worth reading only if asked for. Giving it its own kind would mean a second collapsing
   * row that behaves identically, and a second path for the transcript to render.
   */
  skill?: 'user' | 'agent' | 'context';
  /** When it began, so a long-running call can say how long it has been going. */
  startedAt?: string;
  /** When it stopped, whether it finished or was cancelled. Absent while it runs. */
  endedAt?: string;
  /**
   * What a delegated task did, for the row that delegated it.
   *
   * The subagent's own work is not the parent's conversation, so it is nested inside this
   * row rather than laid out beside it - which is what the CLI does, and what lets a
   * delegating turn be watched without the parent losing its thread (#11).
   */
  delegated?: Delegated;
  /**
   * The subagent's own timeline, drawn inside this row.
   *
   * Built here rather than filtered anywhere: the transcript partitions a subagent's events
   * out of the parent's stream and hands them back through the same function, so a replayed
   * session nests exactly as a watched one does. Work whose delegating row is further back
   * than the page reaches gets a row of its own rather than being dropped.
   */
  children?: Entry[];
}

/** A task handed to a subagent, as the delegating row reports it. */
export interface Delegated {
  /** The agent's own name for itself, which is what the reader chose to delegate to. */
  agent: string;
  /** How many tools it used, once it has finished. */
  toolCalls?: number;
  tokens?: number;
  durationMs?: number;
  /** Absent while it is still working, which is also what a session that stopped leaves. */
  outcome?: 'completed' | 'failed';
}

export type Entry = MessageEntry | ReasoningEntry | ToolEntry;

function text(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Give up on calls that will never report back.
 *
 * A call interrupted mid-flight gets no completion of its own, so the event that ended the
 * turn is also when it stopped - without which its timer would keep counting for as long as
 * the transcript stayed open.
 */
function cancel(pending: Map<string, ToolEntry>, at?: string): void {
  for (const entry of pending.values()) {
    entry.status = 'cancelled';
    entry.endedAt = at;
  }
  pending.clear();
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
      return 'Stopped after reaching the credit limit';
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
  // What the runtime calls a command the reader asked for themselves, rather than one the
  // agent chose. Named the same as the agent's own shell calls, since it is the same shell.
  local_shell: 'Shell',
  grep: 'Search',
  rg: 'Search',
  // The file tools, in the CLI's own words. It calls a view "Read" whether or not a range
  // was given, and names str_replace and edit alike, since they are one tool under two names.
  view: 'Read',
  create: 'Create',
  edit: 'Edit',
  str_replace: 'Edit',
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
  // A tool that ran in a shell reports what the shell wrote, escapes included. Stripped
  // here rather than where the command was issued, so a log replayed from disk - which
  // nothing else touches on the way in - reads the same as one watched live.
  const trimmed = stripAnsi(value).trim();
  return trimmed.length > MAX_OUTPUT ? `${trimmed.slice(0, MAX_OUTPUT)}…` : trimmed;
}

/** What a finished tool call came to, which is the expensive half of building its row. */
interface Outcome {
  output: string;
  patch: string | undefined;
}

/**
 * What each completion came to, so a finished tool call is read once rather than on every
 * chunk of every reply after it.
 *
 * The timeline is rebuilt from scratch whenever anything arrives, and the tool rows are most
 * of what that costs: on a 60k-event log the whole walk is 24ms, of which 16 is the tool
 * payloads - `stripAnsi` over every byte a shell command ever wrote, again per chunk, for
 * calls that finished hours ago (#186).
 *
 * Sound because a completion is finished: its output and its diff are a function of that one
 * event, which never changes once it has arrived. Everything about the row that *can* still
 * change - a subagent's work arriving underneath it, a question's answer - is left outside
 * this and worked out every time as before.
 *
 * Held weakly, so this follows the events rather than holding them: an event dropped by the
 * page that held it takes its outcome with it, which matters in an app whose whole premise is
 * not holding what it is not using.
 */
const outcomes = new WeakMap<TranscriptEvent, Outcome>();

/**
 * The same, for the output a tool reports while it is still running.
 *
 * Each of these carries the whole output so far rather than the increment, so a chatty
 * command leaves behind a run of events that are each nearly as long as the last - and a log
 * read from disk holds every one of them, where a live session only keeps the newest. Left
 * uncached, replaying one meant stripping escapes from the same text over and over.
 */
const partials = new WeakMap<TranscriptEvent, string>();

/**
 * The line under a tool's name, which is worked out from its arguments.
 *
 * Cheaper to keep than to redo: the summary flattens whitespace and clamps a long command or
 * question, and a page holds thousands of calls that will never say anything different.
 *
 * The working directory comes from outside the event - paths are shown relative to it - so it
 * is kept alongside and checked, rather than assumed. A reader who moves a session to another
 * folder gets summaries worked out again instead of stale ones.
 */
const summaries = new WeakMap<TranscriptEvent, { cwd: string | null; summary: string }>();

/**
 * Why a skill loaded.
 *
 * The distinction is most of the point of the row: a skill the reader asked for needs no
 * explaining, while one the agent reached for on its own, or one that arrived with a chosen
 * agent, accounts for behaviour nobody asked for. An unknown trigger reads as user-invoked,
 * the case that says least.
 */
const TRIGGER: Record<string, ToolEntry['skill']> = {
  'user-invoked': 'user',
  'agent-invoked': 'agent',
  'context-load': 'context',
};

/**
 * Event types that draw nothing, and are dropped before the timeline is built.
 *
 * These are lifecycle markers rather than things the reader can see. They are also half of a
 * long log by count - 135,494 of 267,473 events across the twelve largest here - and every
 * one was walked, matched against every case below, and discarded, on every streamed chunk.
 *
 * Dropping them first makes a case for one of them unreachable, so no test that feeds one
 * through can tell a missing case from a dead one. The test that keeps this honest reads
 * this file and fails if any of these ever acquires a case, which is the only place the
 * question can still be asked.
 */
export const DRAWS_NOTHING: ReadonlySet<string> = new Set([
  'assistant.turn_start',
  'assistant.turn_end',
  'hook.start',
  'hook.end',
]);

/** Longest question shown in a row header before clamping. */
const MAX_HEADER = 140;

function clipLine(value: string): string {
  const flat = stripAnsi(value).replace(/\s+/g, ' ').trim();
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
 *
 * @param abandoned what a stopped turn had already said, by the id of the abort that ended
 *   it. The runtime writes streamed text down only when a turn finishes, so this is the
 *   only record of a reply that was interrupted.
 */
export function toEntries(
  all: TranscriptEvent[],
  cwd: string | null,
  abandoned?: ReadonlyMap<string, string>,
  /**
   * Whose timeline is being built, when it is a subagent's rather than the session's.
   *
   * Without it the recursive call sets the very events it was given aside again, since they
   * all carry an agentId, and every subagent's work came back empty. What separates the two
   * streams is not having an agentId but having a *different* one.
   */
  ofAgent?: string,
): Entry[] {
  // Before anything reads them, including the pre-passes and the partitioning: a type that
  // draws nothing has nothing to say to any of it. Doing it here rather than at the caller
  // covers the recursive call a subagent's work makes, and means a synthesised row for a
  // delegation this page cannot see starts at the agent's first visible event rather than at
  // a hook that happened to fire just before it.
  const events = all.filter((event) => !DRAWS_NOTHING.has(event.type));

  const entries: Entry[] = [];
  /** Thinking already shown as it was written, so the message repeating it is skipped. */
  const streamed = new Set<string>();
  /** In-flight tool calls, so a completion can fill in the entry it belongs to. */
  const pending = new Map<string, ToolEntry>();
  /**
   * Delegating rows by the tool call that spawned the subagent, so its outcome can reach
   * the row after the call has completed and left `pending`.
   *
   * Keyed on the tool call rather than on the agent, because the agent's own id has changed
   * form across CLI versions - older sessions reuse the tool call id, newer ones mint a
   * uuid, and one log carries both. `subagent.started` names the tool call in every version.
   */
  const delegating = new Map<string, ToolEntry>();
  /** The row each subagent's work belongs inside, by the agent's own id. */
  const rowOfAgent = new Map<string, ToolEntry>();
  /** What each agent is called, for work whose delegating row this page does not reach. */
  const namedAgent = new Map<string, string>();

  /**
   * A subagent's work, set aside to be built into its own timeline.
   *
   * Partitioned before anything is drawn rather than filtered inside the loop, so the
   * subagent's events keep their order and their pairing - a tool call and its completion
   * have to meet, and they only do if they are handled together and apart from the parent's.
   */
  const ownWork = new Map<string, TranscriptEvent[]>();
  const root: TranscriptEvent[] = [];
  /**
   * Which agent made each tool call, so a lifecycle event can be given to whoever delegated
   * rather than always to the session.
   *
   * A `subagent.started` names the child, not the parent - so routing it by its own agentId
   * would file it under the agent it is announcing. The tool call it names is the one piece
   * that belongs to the delegator, and a delegation made from inside a subagent is a real
   * case: 24 of them across 190 logs here.
   */
  const callerOf = new Map<string, string | undefined>();
  for (const event of events) {
    const id = (event.data as Record<string, unknown> | undefined)?.toolCallId;
    if (typeof id === 'string' && !SUBAGENT_LIFECYCLE.has(event.type)) callerOf.set(id, event.agentId);
  }

  /** Who delegated to each agent, from the call its announcement names. */
  const parentOf = new Map<string, string | undefined>();
  for (const event of events) {
    if (event.type !== 'subagent.started' || !event.agentId) continue;
    const id = (event.data as Record<string, unknown> | undefined)?.toolCallId;
    if (typeof id === 'string') parentOf.set(event.agentId, callerOf.get(id));
  }

  /**
   * The agent this timeline delegated to, somewhere above the one that produced the event.
   *
   * A bucket holds a whole delegation subtree rather than one agent's own events, because
   * the level below is what splits it again: handing the recursion only the direct child's
   * events leaves a grandchild's work behind, with a row built for it here and nothing to
   * put inside. The depth is not known in advance, so this climbs until it finds the agent
   * this timeline itself delegated to.
   */
  const delegatedTo = (agent: string | undefined): string | undefined => {
    let current = agent;
    // Bounded, so a log that somehow describes a cycle cannot hang the transcript.
    for (let step = 0; current && current !== ofAgent && step <= parentOf.size; step++) {
      const parent = parentOf.get(current);
      if (parent === ofAgent || parent === undefined) return current;
      current = parent;
    }
    return current === ofAgent ? undefined : current;
  };

  for (const event of events) {
    const spawning = SUBAGENT_LIFECYCLE.has(event.type)
      ? (event.data as Record<string, unknown> | undefined)?.toolCallId
      : undefined;
    // A lifecycle event belongs to the timeline that made the call, which is the session
    // unless a subagent did the delegating.
    const owner = SUBAGENT_LIFECYCLE.has(event.type)
      ? (typeof spawning === 'string' ? callerOf.get(spawning) : undefined)
      : event.agentId;
    const bucketed = owner === ofAgent ? undefined : delegatedTo(owner);

    if (bucketed) {
      const bucket = ownWork.get(bucketed) ?? [];
      bucket.push(event);
      ownWork.set(bucketed, bucket);
    } else {
      root.push(event);
    }
  }

  for (const event of root) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    // Position is not identity: loading older history prepends events and shifts every
    // index, which would hand a row's local state to a different entry.
    const key = event.id ?? `${event.type}:${entries.length}`;

    switch (event.type) {
      case 'user.message': {
        const content = text(data, 'content');
        if (content) entries.push({ kind: 'message', key, variant: 'user', body: content, at: event.timestamp });
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
        if (content) {
          entries.push({ kind: 'message', key: messageKey(data, key), variant: 'assistant', body: content, at: event.timestamp });
        }
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
        if (content) {
          entries.push({
            kind: 'message',
            key: messageKey(data, key),
            variant: 'assistant',
            body: content,
            at: event.timestamp,
            // Still arriving, so anything needing the whole reply - a diagram, which will
            // not parse until its fence closes - waits rather than failing per chunk.
            streaming: true,
          });
        }
        break;
      }

      // A command the reader typed themselves announces itself under its own name rather
      // than as an execution start, but it is the same tool call and completes the same
      // way, so it opens the same row (#134).
      case 'tool.execution_start':
      case 'tool.user_requested': {
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

        // Kept per event, since the arguments it reads never change once they have arrived.
        const held = summaries.get(event);
        let summary: string;
        if (held && held.cwd === cwd) {
          summary = held.summary;
        } else {
          summary = question
            ? clipLine(question)
            : // A command the reader typed is its own summary. The runtime's description
              // for one is "Execute shell command: <the command>", which says the same
              // thing twice and pushes the part that matters off the end of the line.
              clipLine(command && name === 'local_shell' ? command : summarise(args, cwd));
          summaries.set(event, { cwd, summary });
        }

        const entry: ToolEntry = question
          ? {
              kind: 'tool',
              key,
              name: label,
              summary,
              output: null,
              status: 'running',
              startedAt: event.timestamp,
              question: true,
              choices: Array.isArray(args?.choices)
                ? args.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
                : undefined,
            }
          : {
              kind: 'tool',
              key,
              name: label,
              summary,
              output: null,
              status: 'running',
              startedAt: event.timestamp,
              command,
              path: typeof args?.path === 'string' && args.path.trim() ? args.path : undefined,
              search: search || undefined,
            };

        const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
        if (id) pending.set(id, entry);
        entries.push(entry);
        break;
      }

      /**
       * A task was handed to a subagent.
       *
       * Recorded against the row that delegated it rather than added as a row of its own:
       * the `task` tool call is already there, and this says who took it. The subagent's
       * own messages and tool calls never reach here at all - they are filtered out of the
       * transcript before it is read, because they are another agent's conversation.
       */
      case 'subagent.started': {
        const call = text(data, 'toolCallId');
        const agent = text(data, 'agentDisplayName') ?? text(data, 'agentName');
        const row = call ? (pending.get(call) ?? delegating.get(call)) : undefined;
        if (!call || !agent) break;

        // Remembered whether or not the row that delegated is in this page, so work whose
        // call is further back than the page reaches can still say whose it was.
        if (event.agentId) namedAgent.set(event.agentId, agent);

        if (row) {
          row.delegated = { agent };
          delegating.set(call, row);
          if (event.agentId) rowOfAgent.set(event.agentId, row);
        }
        break;
      }

      /**
       * How the delegated task went.
       *
       * Both outcomes are real and both are common: one session here failed sixteen of its
       * ninety-three. A subagent left running by a session that stopped reaches neither,
       * which is why the outcome is absent rather than assumed.
       */
      case 'subagent.completed':
      case 'subagent.failed': {
        const call = text(data, 'toolCallId');
        const row = call ? delegating.get(call) : undefined;
        if (!row?.delegated) break;

        row.delegated = {
          ...row.delegated,
          outcome: event.type === 'subagent.completed' ? 'completed' : 'failed',
          ...(typeof data.totalToolCalls === 'number' ? { toolCalls: data.totalToolCalls } : {}),
          ...(typeof data.totalTokens === 'number' ? { tokens: data.totalTokens } : {}),
          ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
        };
        break;
      }

      /**
       * What a running tool has produced so far, so a slow command reads as progress
       * rather than as a hang. Ephemeral, so it only ever arrives live.
       *
       * The payload is cumulative, so it is assigned rather than appended.
       */
      case 'tool.execution_partial_result': {
        const running = typeof data.toolCallId === 'string' ? pending.get(data.toolCallId) : undefined;
        const soFar = data.partialOutput;
        if (!running || typeof soFar !== 'string' || soFar === '') break;

        let shown = partials.get(event);
        if (shown === undefined) {
          shown = clip(soFar);
          partials.set(event, shown);
        }
        running.output = shown;
        break;
      }

      case 'tool.execution_complete': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
        const entry = id ? pending.get(id) : undefined;
        if (id) pending.delete(id);

        const succeeded = data.success === true;
        // Read once per completion rather than once per chunk. Everything below this is
        // cheap; what it skips is stripping escapes from every byte a shell ever wrote.
        let outcome = outcomes.get(event);
        if (!outcome) {
          const result = data.result as { content?: unknown; detailedContent?: unknown } | undefined;
          const error = data.error as { message?: unknown } | undefined;
          // A file tool reports the change it made as a unified diff, which is worth far
          // more than the sentence saying it succeeded.
          const detail = result?.detailedContent;

          outcome = {
            output: succeeded
              ? typeof result?.content === 'string'
                ? clip(result.content)
                : ''
              : typeof error?.message === 'string'
                ? clip(error.message)
                : 'Tool failed',
            patch: typeof detail === 'string' && detail.includes('diff --git') ? detail : undefined,
          };
          outcomes.set(event, outcome);
        }
        const { output, patch } = outcome;

        if (entry) {
          // Updating the entry already in the list keeps the tool as one visual unit.
          entry.status = succeeded ? 'ok' : 'failed';
          entry.output = output || null;
          entry.patch = patch;
          entry.endedAt = event.timestamp;

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

      // A skill that was loaded into the conversation. Worth a row because its content
      // becomes part of what the agent was told, and a reader wondering why a session
      // behaved unusually has no other way to see that it arrived.
      case 'skill.invoked': {
        const name = text(data, 'name');
        if (name) {
          const command = text(data, 'commandName');
          const content = text(data, 'content');
          entries.push({
            kind: 'tool',
            key,
            name: command ? `/${command}` : name,
            summary: text(data, 'description') ?? '',
            // The whole SKILL.md, trimmed like any other output: it is what the agent was
            // handed, and is occasionally long enough to be the answer on its own.
            output: content ? clip(content) : null,
            status: 'ok',
            skill: TRIGGER[text(data, 'trigger') ?? ''] ?? 'user',
            startedAt: event.timestamp,
            endedAt: event.timestamp,
          });
        }
        break;
      }

      // What a slash command produced. Only ever a local event: a command's output is
      // returned to whoever ran it and written down nowhere, so this row exists for as long
      // as the session stays open and is gone on the next visit.
      case 'command.output': {
        const body = text(data, 'text');
        if (body) {
          entries.push({
            kind: 'message',
            key,
            variant: 'command',
            body,
            preformatted: data.markdown !== true,
            at: event.timestamp,
          });
        }
        break;
      }

      // A command that could not run. Belongs here rather than in a banner over the top:
      // it answers something that was typed into the transcript, and reads as the reply to
      // it. Local for the same reason as its output - nothing about it is written down.
      case 'command.failed': {
        const body = text(data, 'text');
        if (body) entries.push({ kind: 'message', key, variant: 'failed', body, at: event.timestamp });
        break;
      }

      // An interrupted turn never emits tool.execution_complete, so anything still
      // pending when the session stops will never complete. Without this such a row
      // stays "running" forever, including on every later replay.
      //
      // An abort emits `abort` then `assistant.turn_end`, with no `session.idle` at all,
      // so all three signals are needed rather than idle alone.
      case 'abort':
        // The text the agent had already said, which the runtime never writes down: a
        // stopped turn emits no assistant.message, so without this the reply that was on
        // screen a moment ago is gone on the next visit as though it never happened.
        {
          const said = abandoned?.get(key);
          if (said) entries.push({ kind: 'message', key: `${key}-partial`, variant: 'assistant', body: said, partial: true });
        }
        // A reply that simply stops mid-sentence reads as the app losing the thread. The
        // event is written to the log, so this says so on every later replay too.
        entries.push({ kind: 'message', key, variant: 'stopped', body: stopReason(data) });
        cancel(pending, event.timestamp);
        break;

      case 'session.idle':
      case 'session.shutdown':
        cancel(pending, event.timestamp);
        break;

      // permission.requested is deliberately absent: the approval panel above the
      // composer already shows it, and its payload is large and unreadable inline.
      default:
        break;
    }
  }

  /**
   * Build each subagent's own timeline and hang it inside the row that delegated it.
   *
   * Through this same function, so a subagent's messages, thinking and tool calls read
   * exactly as the parent's do - and so a subagent that delegates in turn nests again
   * without any of this knowing how deep it goes. Real sessions do that: one here has four
   * task calls made from inside a subagent.
   */
  for (const [agentId, row] of rowOfAgent) {
    const own = ownWork.get(agentId);
    if (own?.length) row.children = toEntries(own, cwd, abandoned, agentId);
  }

  /**
   * Work whose delegating row this page does not reach, given a row of its own.
   *
   * A page is a window on a conversation, and a delegation that began before it leaves its
   * `task` call outside - so there is nothing for the work to hang inside. Dropped, which
   * is what used to happen, it went silently: across 204 real sessions, 65 opening pages
   * carried subagent work and every one of them lost some, one of them drawing three rows
   * out of a hundred and fifty events.
   *
   * At the top, because a delegation this page cannot see the start of began before
   * anything else in it. Collapsed like any other task row, so it costs a line until it is
   * asked for - and it stops being synthesised the moment scrolling up brings the real row
   * into range, since all of this is rebuilt from whatever events are held.
   */
  const orphaned: Entry[] = [];
  for (const [agentId, own] of ownWork) {
    if (rowOfAgent.has(agentId) || own.length === 0) continue;

    const agent = namedAgent.get(agentId) ?? 'a delegated task';
    orphaned.push({
      kind: 'tool',
      key: `agent:${agentId}`,
      name: 'Task',
      summary: agent,
      status: 'ok',
      output: null,
      startedAt: own[0]?.timestamp,
      delegated: { agent },
      children: toEntries(own, cwd, abandoned, agentId),
    });
  }

  return orphaned.length > 0 ? [...orphaned, ...entries] : entries;
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
    return (
      a.variant === other.variant &&
      a.body === other.body &&
      a.partial === other.partial &&
      a.preformatted === other.preformatted &&
      a.at === other.at &&
      a.streaming === other.streaming
    );
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
    a.path === other.path &&
    a.search === other.search &&
    a.startedAt === other.startedAt &&
    a.endedAt === other.endedAt &&
    sameDelegated(a.delegated, other.delegated) &&
    sameChildren(a.children, other.children) &&
    sameChoices(a.choices, other.choices)
  );
}

/**
 * Whether two rows describe the same delegated task in the same state.
 *
 * Compared field by field for the same reason everything else here is: the list is rebuilt
 * on every render, so a subagent that has just finished is a different object carrying the
 * same identity, and a row left out of this comparison would go on saying it is running.
 */
function sameDelegated(a: Delegated | undefined, b: Delegated | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.agent === b.agent &&
    a.outcome === b.outcome &&
    a.toolCalls === b.toolCalls &&
    a.tokens === b.tokens &&
    a.durationMs === b.durationMs
  );
}

/**
 * Whether a delegated task's nested timeline is unchanged.
 *
 * Compared row by row through the same rule, since the children are entries like any other
 * and are rebuilt with their parent. Without this a subagent's work would freeze at
 * whatever it had done when its row was first drawn - which is the whole of what the row
 * exists to show while it runs.
 */
function sameChildren(a: Entry[] | undefined, b: Entry[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((entry, index) => sameEntry(entry, b[index]!));
}

function sameChoices(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((choice, index) => choice === b[index]);
}
