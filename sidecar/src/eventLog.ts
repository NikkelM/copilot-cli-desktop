/**
 * A session's transcript, read from its log file a window at a time.
 *
 * Deliberately overlaps the SDK's `session.eventLog.read` and `sessions.readPersistedEvents`
 * (#143). Both need the session loaded; this reads history for a session nobody has opened,
 * which is what lets browsing cost nothing. It also reads from the end backwards, because
 * the interesting part of a hundred-megabyte log is always its last page.
 */
import { existsSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

import type {
  DelegatedTask,
  GetTranscriptResult,
  SessionAgent,
  SessionModel,
  SessionMode,
  SessionUsage,
  TranscriptEvent,
} from '../../shared/protocol.js';
import { isSidekick, showsInTranscript } from '../../shared/protocol.js';
import { sessionEventLog } from './paths.js';

/** Default cap on events per read; logs reach hundreds of thousands of entries. */
const DEFAULT_LIMIT = 500;

/**
 * How many delegated tasks a page carries.
 *
 * A screenful and then some. The point of paging is that a reader looking for a task they
 * remember wants a recent one, so the first page is nearly always the only one read.
 */
const DEFAULT_TASKS = 30;

/** First slice read from the end of the range. Comfortably covers a typical 500 events. */
const INITIAL_WINDOW = 256 * 1024;

/** How much the window grows when the tail did not hold enough events. */
const GROWTH_FACTOR = 4;

/**
 * Enough of the front of a log to hold its first line, which is the only line this asks about.
 *
 * Generous rather than exact: the first event carries the model, the working directory and
 * the tools a run opened with, and one here runs to 12kB.
 */
const FIRST_LINE_WINDOW = 64 * 1024;

/**
 * What a log has to begin with for the CLI to open that session again.
 *
 * The runtime rebuilds a session by replaying its log from the top, so the first event has to
 * be the one that starts a run. Its own refusal says so in as many words - "no valid
 * session.start event was found" - and `explain` already turns that into a sentence, but only
 * after somebody has sent a message and waited.
 *
 * Both are accepted because both open a run: a session resumed rather than started fresh
 * carries the second.
 */
const OPENS_A_RUN = new Set(['session.start', 'session.resume']);

/**
 * Whether the CLI could open this session again.
 *
 * Read from the front, unlike everything else here, because that is where the answer is.
 * One line of a file already open, so it costs a single read of the head rather than a walk.
 *
 * True where the question cannot be answered. A log that is missing, unreadable or still
 * being written is not evidence of a session that has lost its history, and saying so would
 * put a warning on a session that is merely new.
 */
async function reopenableFrom(file: FileHandle, size: number): Promise<boolean> {
  if (size === 0) return true;

  const buffer = Buffer.alloc(Math.min(FIRST_LINE_WINDOW, size));
  await file.read(buffer, 0, buffer.length, 0);

  const text = buffer.toString('utf8');
  const newline = text.indexOf('\n');

  try {
    const first = JSON.parse(newline === -1 ? text : text.slice(0, newline)) as { type?: unknown };
    return typeof first.type === 'string' ? OPENS_A_RUN.has(first.type) : true;
  } catch {
    // Covers a first line longer than the window as well as one that is not JSON: a
    // truncated object does not parse, so both arrive here and both mean "no idea".
    return true;
  }
}

/**
 * Stop growing rather than read an entire multi-hundred-megabyte log.
 * Returning slightly fewer events is a far better outcome than a long freeze.
 */
const MAX_WINDOW = 32 * 1024 * 1024;

interface LocatedEvent {
  event: TranscriptEvent;
  /** Byte offset where this event's line begins. */
  offset: number;
}

/**
 * Replay part of a session's transcript without loading it into the CLI runtime.
 *
 * Read backwards from the end of the range rather than streaming from the start. Logs
 * reach 287 MB locally and total about 1.8 GB, so scanning forward to keep the newest 500
 * events cost roughly three seconds per open, which contradicts the whole point of
 * browsing being cheap.
 *
 * events.jsonl uses the same shape as the SDK's live event stream, so the renderer treats
 * replayed and live events identically.
 *
 * @param before byte offset to treat as the end of the file, for paging further back
 */
export async function readTranscript(
  sessionId: string,
  limit = DEFAULT_LIMIT,
  before?: number,
): Promise<GetTranscriptResult> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return { events: [], truncated: false, nextBefore: null };

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const end = before === undefined ? size : Math.max(0, Math.min(before, size));
    // Only the opening page asks. The pages after it are the same log read further back,
    // and the answer cannot have changed between them.
    const reopenable = before === undefined ? await reopenableFrom(file, size) : undefined;
    const answer = (result: Omit<GetTranscriptResult, 'reopenable'>): GetTranscriptResult =>
      reopenable === undefined ? result : { ...result, reopenable };

    if (end === 0) return answer({ events: [], truncated: false, nextBefore: null });

    let window = Math.min(INITIAL_WINDOW, end);

    for (;;) {
      const start = Math.max(0, end - window);
      const reachedStart = start === 0;

      const buffer = Buffer.alloc(end - start);
      await file.read(buffer, 0, buffer.length, start);

      /**
       * Only what the transcript can draw counts towards the page.
       *
       * The budget exists to bound what a page costs to render, and only these events are
       * rendered - so counting the rest would make a page mean different amounts of
       * conversation depending on how much invisible traffic happened to sit in it. A
       * delegating session made that concrete: its last hundred and fifty events were all
       * one subagent's, so a page counted in raw events contained nothing to show at all.
       *
       * Filtered here rather than in `locateEvents`, which the model, agent and mode
       * readers share: those exist to read events the transcript never shows.
       */
      const located = locateEvents(buffer, start, reachedStart).filter((entry) =>
        showsInTranscript(entry.event.type),
      );

      if (located.length >= limit || reachedStart || window >= MAX_WINDOW) {
        const kept = located.slice(-limit);
        const more = !reachedStart || kept.length < located.length;

        return answer({
          events: kept.map((entry) => entry.event),
          truncated: more,
          // Where the next page should stop reading. Points at the first event actually
          // returned, not the window start, since the window's first line is normally
          // partial and further events may be dropped when slicing to the limit.
          nextBefore: more ? (kept[0]?.offset ?? null) : null,
        });
      }

      window = Math.min(window * GROWTH_FACTOR, end, MAX_WINDOW);
    }
  } finally {
    await file.close();
  }
}

/**
 * One subagent's own transcript, read from its session's log (#178).
 *
 * The parent holds a subagent's events in memory so the row that delegated it can draw
 * them, which is a commitment that grows with every delegation a session makes - one run
 * here comes to 3.3 MB. Reading them back instead means the parent need only remember that
 * the agent existed.
 *
 * Backwards from the end, in the same growing window the transcript pages with, and stops
 * at the `subagent.started` that opened the run. That is what makes this affordable: a run
 * is contiguous, so the work is proportional to how recently it happened rather than to the
 * log. Measured against the largest log on this machine, 697 MB: the newest run began 0.54
 * MB from the end, and reading it whole took 5 ms.
 *
 * A run still in flight has no `subagent.started` behind it only if the window ran out
 * first, so what comes back is what the log has - the caller decides whether that is
 * enough, since it is the one holding the live events this may be behind.
 */
export async function readAgentTranscript(sessionId: string, agentId: string): Promise<TranscriptEvent[]> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return [];

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return [];

    let window = Math.min(INITIAL_WINDOW, size);

    for (;;) {
      const start = Math.max(0, size - window);
      const reachedStart = start === 0;

      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);

      const mine = locateEvents(buffer, start, reachedStart)
        .map((entry) => entry.event)
        .filter((event) => event.agentId === agentId && showsInTranscript(event.type));

      // The announcement that opened the run, so everything it did is behind us.
      const whole = mine.some((event) => event.type === 'subagent.started');

      if (whole || reachedStart || window >= MAX_WINDOW) return mine;

      window = Math.min(window * GROWTH_FACTOR, size, MAX_WINDOW);
    }
  } finally {
    await file.close();
  }
}

/**
 * The tasks a session delegated, newest first, a page at a time (#228).
 *
 * The sidebar lists only what this app watched start, which leaves three kinds of task
 * unreachable: one hidden, one from a previous run, and one from a session used in a
 * terminal. All of them are in the log, and this is how they are found again.
 *
 * Paged rather than scanned whole. Finding every task means reading the whole log - 1.9
 * seconds for the largest here, against milliseconds for a median one - and a reader
 * looking for a task they remember almost always wants a recent one. So a page is read
 * backwards from the end and the rest is offered rather than paid for.
 *
 * A task's end sits beside its beginning, because a run is contiguous, so a page normally
 * carries both. One whose end falls past the page reports no outcome rather than a guessed
 * one: on the first page that means it is still running, and further back it means the page
 * boundary fell inside it.
 */
export async function readDelegatedTasks(
  sessionId: string,
  limit = DEFAULT_TASKS,
  before?: number,
): Promise<{ agents: DelegatedTask[]; truncated: boolean; nextBefore: number | null }> {
  const path = sessionEventLog(sessionId);
  const empty = { agents: [], truncated: false, nextBefore: null };
  if (!existsSync(path)) return empty;

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const end = before === undefined ? size : Math.max(0, Math.min(before, size));
    if (end === 0) return empty;

    let window = Math.min(INITIAL_WINDOW, end);

    for (;;) {
      const start = Math.max(0, end - window);
      const reachedStart = start === 0;

      const buffer = Buffer.alloc(end - start);
      await file.read(buffer, 0, buffer.length, start);

      const found = tasksIn(locateEvents(buffer, start, reachedStart));

      if (found.length >= limit || reachedStart || window >= MAX_WINDOW) {
        // Newest first, which is the order a reader looking for one they remember wants.
        const newest = found.slice(-limit).reverse();
        const more = !reachedStart || newest.length < found.length;

        return {
          agents: newest,
          truncated: more,
          // Where the next page should stop reading: the oldest task this one returned, so
          // the two meet without overlapping.
          nextBefore: more ? (newest[newest.length - 1]?.offset ?? null) : null,
        };
      }

      window = Math.min(window * GROWTH_FACTOR, end, MAX_WINDOW);
    }
  } finally {
    await file.close();
  }
}

/**
 * The delegated tasks a window of events describes, oldest first.
 *
 * A task is its announcement. An ending with no beginning in the window belongs to a task
 * older than the window, which the page before this one will find, so it is left alone
 * rather than turned into a task with no name.
 */
function tasksIn(events: readonly LocatedEvent[]): DelegatedTask[] {
  const started = new Map<string, DelegatedTask>();

  /**
   * Which agent made each tool call, so a task can be told who delegated it.
   *
   * A task's announcement names the call that spawned it, and whoever made that call is its
   * parent - undefined when that was the session itself. Lifecycle events name the same
   * call without having made it, so they are left out or a task would parent itself.
   */
  const callerOf = new Map<string, string | undefined>();
  for (const { event } of events) {
    const id = (event.data as Record<string, unknown> | undefined)?.toolCallId;
    if (typeof id === 'string' && !event.type.startsWith('subagent.')) callerOf.set(id, event.agentId);
  }

  for (const { event, offset } of events) {
    const agentId = event.agentId;
    // The runtime's own background agents, which are its housekeeping rather than work this
    // session asked for.
    if (!agentId || isSidekick(agentId)) continue;

    const data = (event.data ?? {}) as Record<string, unknown>;

    if (event.type === 'subagent.started') {
      const call = data.toolCallId;
      const parent = typeof call === 'string' ? callerOf.get(call) : undefined;

      started.set(agentId, {
        agentId,
        name: String(data.agentDisplayName ?? data.agentName ?? 'agent'),
        startedAt: String(event.timestamp ?? ''),
        offset,
        ...(textOf(data.model) ? { model: textOf(data.model) } : {}),
        ...(parent ? { parentAgentId: parent } : {}),
      });
      continue;
    }

    if (event.type !== 'subagent.completed' && event.type !== 'subagent.failed') continue;

    const task = started.get(agentId);
    if (!task) continue;

    task.outcome = event.type === 'subagent.completed' ? 'completed' : 'failed';
    if (typeof data.error === 'string' && data.error) task.error = data.error;
    if (typeof data.totalToolCalls === 'number') task.toolCalls = data.totalToolCalls;
    if (typeof data.totalTokens === 'number') task.tokens = data.totalTokens;
    if (typeof data.durationMs === 'number') task.durationMs = data.durationMs;
  }

  return [...started.values()];
}

/**
 * The model a session was last using, read from its log.
 *
 * Read from both ends, because neither alone is enough. A change is recorded wherever it
 * happened, so the tail is where a recent one will be; but a session that has simply been
 * running on the same model for a long time has no change anywhere near the end. One log
 * here is 300 MB with nothing to say about its model in the last 32 MB, while the first
 * line of every log names the model the run opened with.
 *
 * Both reads are bounded, so this costs a few hundred kilobytes rather than a process: a
 * session can say what it runs on without being started to ask.
 */
export async function lastModel(sessionId: string): Promise<SessionModel | null> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return null;

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return null;

    const found = await modelBefore(file, size);

    // The opening of the run is worth reading when the walk named a model without saying how
    // it was set up, which is not unusual: a change event often carries the model and the
    // effort but not the context. There is no case for reading it when nothing was named at
    // all, since a walk that found nothing has already been past the opening itself.
    if (found && (!found.reasoningEffort || !found.contextTier)) {
      const opening = latestModelIn(await eventsIn(file, 0, Math.min(INITIAL_WINDOW, size), true));

      if (opening) {
        found.reasoningEffort ??= opening.reasoningEffort;
        found.contextTier ??= opening.contextTier;
      }
    }

    return found;
  } finally {
    await file.close();
  }
}

/**
 * The custom agent a session was last put on, read from its log.
 *
 * Read from both ends for the same reason `lastModel` is. A selection made recently sits near
 * the tail, while one made when the session was created sits in its first lines and nowhere
 * else, because `sessions.create` takes an agent and records choosing it exactly once.
 *
 * What this misses is a selection made in the middle of a very long session and never touched
 * since, because both reads are bounded and being bounded is the point. The consequence is
 * mild and self-correcting: the session reads as being on the default agent until it is
 * loaded, at which point the runtime's own `agent.getCurrent` answers and is authoritative.
 */
export async function lastAgent(sessionId: string): Promise<SessionAgent | null> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return null;

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return null;

    let window = Math.min(INITIAL_WINDOW, size);

    for (;;) {
      const start = Math.max(0, size - window);
      const reachedStart = start === 0;

      const found = latestAgentIn(await eventsIn(file, start, size, reachedStart));
      if (found) return found.agent;

      // Reaching the start means the whole log has been read and there is nothing to find,
      // so the opening is not worth reading again.
      if (reachedStart) return null;
      if (window >= MAX_WINDOW) break;

      window = Math.min(window * GROWTH_FACTOR, size, MAX_WINDOW);
    }

    return latestAgentIn(await eventsIn(file, 0, Math.min(INITIAL_WINDOW, size), true))?.agent ?? null;
  } finally {
    await file.close();
  }
}

/**
 * What a slice of the log says a session's agent is, the newest mention winning.
 *
 * Wrapped rather than returned bare because being deselected is an answer. It means the
 * default agent, which is a different thing from the slice having nothing to say; without the
 * distinction a deselection would read as a miss and the search would carry on past the very
 * event that settled it, to an older selection that has since been undone.
 */
function latestAgentIn(events: TranscriptEvent[]): { agent: SessionAgent | null } | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];

    if (event.type === 'subagent.deselected') return { agent: null };
    if (event.type !== 'subagent.selected') continue;

    const data = (event.data ?? {}) as Record<string, unknown>;
    const name = textOf(data.agentName);
    if (!name) continue;

    return { agent: { name, displayName: textOf(data.agentDisplayName) ?? name } };
  }

  return null;
}

/**
 * How a session was last working, read from its log.
 *
 * A bounded tail read, and only the tail: a session opens in `interactive` and records
 * nothing to say so, so unlike a model there is no opening line to fall back on. Absence
 * really is the answer, which is why this returns a mode rather than null.
 *
 * Reading only the tail misses a change made early in a very long session and never
 * touched since, and that is the same trade `lastAgent` makes for the same reason. It is
 * cheap to be wrong about: the session reads as interactive until it is loaded, at which
 * point `session.mode.get` answers and is authoritative.
 *
 * `user.message.agentMode` looks like a second source and is not. It is optional, and
 * across every session on this machine it is never written - so trusting it would add a
 * branch that only ever costs time.
 */
export async function lastMode(sessionId: string): Promise<SessionMode> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return 'interactive';

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return 'interactive';

    let window = Math.min(INITIAL_WINDOW, size);

    for (;;) {
      const start = Math.max(0, size - window);
      const reachedStart = start === 0;

      const found = latestModeIn(await eventsIn(file, start, size, reachedStart));
      if (found) return found;

      if (reachedStart || window >= MAX_WINDOW) return 'interactive';
      window = Math.min(window * GROWTH_FACTOR, size, MAX_WINDOW);
    }
  } finally {
    await file.close();
  }
}

/**
 * What a session has spent, from the last usage checkpoint written to its log.
 *
 * The runtime writes one of these as a turn settles, carrying the two running totals. They
 * are the same figures a resumed session reports for them - verified against two real
 * sessions, where `usage.getMetrics` after a resume answered with exactly the numbers in
 * the last checkpoint - so a cold session can account for itself without being started.
 *
 * The richer part of a session's usage, its tokens and per-model breakdown, is not here.
 * That is rebuilt by the runtime on resume and is only worth having from a session that is
 * already loaded.
 *
 * Read backwards in growing windows like the other cold reads, so this costs a few hundred
 * kilobytes of a log that may be hundreds of megabytes.
 */
export async function lastUsage(sessionId: string): Promise<SessionUsage | null> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return null;

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return null;

    let window = Math.min(INITIAL_WINDOW, size);

    for (;;) {
      const start = Math.max(0, size - window);
      const reachedStart = start === 0;

      const found = latestUsageIn(await eventsIn(file, start, size, reachedStart));
      if (found) return found;

      if (reachedStart || window >= MAX_WINDOW) return null;
      window = Math.min(window * GROWTH_FACTOR, size, MAX_WINDOW);
    }
  } finally {
    await file.close();
  }
}

/** The newest checkpoint in a slice of the log, which supersedes every earlier one. */
function latestUsageIn(events: TranscriptEvent[]): SessionUsage | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== 'session.usage_checkpoint') continue;

    const data = (event.data ?? {}) as Record<string, unknown>;
    const premiumRequests = numberOf(data.totalPremiumRequests);
    const nanoAiu = numberOf(data.totalNanoAiu);
    // A checkpoint that carries neither total says nothing worth reporting, and reading it
    // as zero would claim a session cost nothing rather than that nothing is known.
    if (premiumRequests === null && nanoAiu === null) continue;

    return {
      premiumRequests: premiumRequests ?? 0,
      aiu: (nanoAiu ?? 0) / 1e9,
      loaded: false,
    };
  }

  return null;
}

/** A number the runtime reported, or nothing when the field is absent or not one. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** What a slice of the log says a session's mode is, the newest change winning. */
function latestModeIn(events: TranscriptEvent[]): SessionMode | null {  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== 'session.mode_changed') continue;

    const mode = textOf((event.data as Record<string, unknown> | undefined)?.newMode);
    // A mode this build does not know is not a reason to stop looking: an older change to
    // one it does know still describes the session better than the default would.
    if (mode === 'interactive' || mode === 'plan' || mode === 'autopilot') return mode;
  }

  return null;
}

/**
 * What a slice of the log says a session runs on, the newest mention of each part winning.
 *
 * Assembled part by part rather than taken from one event, because no single event reliably
 * carries all three: a change often names the model and the effort but not the context, and
 * the line a run opens with sometimes carries the context and no model at all. Reading only
 * the newest event that names a model loses whatever that event left out, which is what put
 * an effort and a context the session really had out of the header.
 */
function latestModelIn(events: TranscriptEvent[]): SessionModel | null {
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let contextTier: string | undefined;

  for (let index = events.length - 1; index >= 0; index--) {
    if (!NAMES_A_MODEL.includes(events[index].type)) continue;

    // A delegated run announces its own model exactly as a session does, and four starting at
    // once is four such lines in three milliseconds. None of them is what the session runs on.
    if (events[index].agentId) continue;

    const data = (events[index].data ?? {}) as Record<string, unknown>;

    model ??= textOf(data.newModel) ?? textOf(data.selectedModel);
    reasoningEffort ??= textOf(data.reasoningEffort);
    contextTier ??= textOf(data.contextTier);

    if (model && reasoningEffort && contextTier) break;
  }

  return model ? { model, reasoningEffort, contextTier } : null;
}

/** Null is what the runtime writes for a setting nobody chose, which is not a value. */
const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The events in one slice of the log, skipping the partial line a mid-file start leaves. */
async function eventsIn(
  file: FileHandle,
  start: number,
  end: number,
  reachedStart: boolean,
): Promise<TranscriptEvent[]> {
  const buffer = Buffer.alloc(end - start);
  await file.read(buffer, 0, buffer.length, start);

  return locateEvents(buffer, start, reachedStart).map((entry) => entry.event);
}

/**
 * The events that say what a session runs on.
 *
 * A change reports the model it moved to; the start or resume of a run reports the one it
 * opened with, under a different name. Four of the twenty-eight logs here have no change in
 * them at all, so the second is not a fallback worth skipping.
 */
const NAMES_A_MODEL = ['session.model_change', 'session.start', 'session.resume'];

/**
 * How much of the log to take at a time when reading back for the model.
 *
 * Larger than the window paging opens with, because this walk is looking for something rare
 * rather than for the most recent events: one log here runs 106MB between one mention of a
 * model and the next, and crossing that at 256kB a time would be a hundred reads of a file
 * that is already open.
 */
const MODEL_SCAN_CHUNK = 4 * 1024 * 1024;

/**
 * Read back through a log for what the session was last set to run on.
 *
 * Paging stops growing its window at a point where returning fewer events is a fair answer.
 * This question has no such answer: stopping early does not report less, it reports the model
 * the session opened with, which for a log spanning months is one nobody has chosen since.
 * That is what put a July model in the header of a session running on a September one.
 *
 * So the walk is not capped. It is kept cheap instead - the names are looked for in the raw
 * text and only a line that carries one is parsed - which leaves the usual case a single
 * chunk, and the worst one here under half a second rather than wrong.
 */
async function modelBefore(file: FileHandle, size: number): Promise<SessionModel | null> {
  const named: TranscriptEvent[] = [];
  let end = size;
  let carry = '';

  while (end > 0) {
    const start = Math.max(0, end - MODEL_SCAN_CHUNK);
    const buffer = Buffer.alloc(end - start);
    await file.read(buffer, 0, buffer.length, start);

    // A read that starts mid-file opens mid-line, and that line's tail was carried back from
    // the chunk before it.
    const lines = (buffer.toString('utf8') + carry).split('\n');
    carry = start === 0 ? '' : (lines.shift() ?? '');

    const inChunk: TranscriptEvent[] = [];
    for (const line of lines) {
      if (!NAMES_A_MODEL.some((name) => line.includes(name))) continue;
      try {
        inChunk.push(JSON.parse(line) as TranscriptEvent);
      } catch {
        // A line that does not parse is one this cannot use, and the walk has further to go.
      }
    }

    // Kept together rather than answered per chunk, because the parts are gathered separately:
    // a context tier recorded after the last change of model is still the current one.
    named.unshift(...inChunk);
    const found = latestModelIn(named);
    if (found) return found;

    end = start;
  }

  return null;
}

/**
 * How much to read when landing at an arbitrary point in a log.
 *
 * Enough to hold a whole event with room to spare, because the read lands mid-line and the
 * first partial one is discarded: one event here reaches 12kB, and a search that had to
 * widen its window at every step would lose what the search is for.
 */
const PROBE_WINDOW = 64 * 1024;

/**
 * Where in the log a moment in time sits.
 *
 * Found by halving rather than by scanning. A log is appended to and never reordered, so its
 * timestamps only go forwards, which is the one property a binary search needs. Scanning
 * instead would cost what `readTranscript` exists to avoid: a forward walk of a 287 MB log
 * takes about three seconds, while this reads a few dozen kilobytes a dozen times whatever
 * the size.
 *
 * The answer is the first event at or after `when`, which is where that turn begins. Null
 * when every event predates it - a turn recorded in the database whose events are not in
 * this log, which is what a truncated or rotated log leaves behind.
 */
async function offsetAt(file: FileHandle, size: number, when: string): Promise<number | null> {
  /** The first whole event beginning at or after `from`, and where it began. */
  const eventFrom = async (from: number): Promise<{ at: number; when: string } | null> => {
    let window = PROBE_WINDOW;

    for (;;) {
      const start = Math.min(from, size);
      const length = Math.min(window, size - start);
      if (length <= 0) return null;

      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, start);
      const [first] = locateEvents(buffer, start, start === 0);
      if (first?.event?.timestamp) return { at: first.offset, when: String(first.event.timestamp) };

      // Nothing whole in the window: either one enormous event, or the tail of the file.
      if (start + length >= size) return null;
      window *= GROWTH_FACTOR;
    }
  };

  let low = 0;
  let high = size;
  let best: number | null = null;

  // Ten or so rounds on any log this app will meet, each one read of a few dozen kilobytes.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const found = await eventFrom(middle);

    // Nothing whole after the midpoint, so the answer is behind it.
    if (!found) {
      high = middle;
      continue;
    }

    if (found.when >= when) {
      best = found.at;
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return best;
}

/**
 * Where a turn ends in a session's log, as a cursor the transcript can open at.
 *
 * Search finds which session said something and which turn it said it in, but a turn index
 * is not a position in a log: the two are kept in different places, and there are more
 * `user.message` events than there are turns - 861 against 790 in one session here - so
 * counting them would land somewhere plausible and wrong. Time is the one thing both agree
 * on, and every event in a log carries it (#30).
 *
 * The cursor points at where the *next* turn begins, because `readTranscript` reads back from
 * a cursor and returns what is before it. So the matched turn is the last thing on the page
 * that opens, with what led up to it above - which is the direction this reader already goes,
 * and the reason a match is worth opening is usually what came before it.
 *
 * `until` is null for the last turn in a session, which runs to the end of the log.
 */
export async function locateTurn(sessionId: string, until: string | null): Promise<number | null> {
  const path = sessionEventLog(sessionId);
  if (!existsSync(path)) return null;

  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) return null;
    // Nothing follows the last turn, so the end of the log is where it ends.
    if (!until) return size;

    const at = await offsetAt(file, size, until);
    // The next turn is not in this log, which a truncated one will do. What was asked for is
    // still somewhere behind the end, so the end is the honest place to stop reading.
    return at ?? size;
  } finally {
    await file.close();
  }
}

/**
 * Parse the lines in a window, recording where each event began.
 *
 * Unless the window reaches the start of the file its first line began before it and is
 * incomplete, so it is skipped. That also discards any partial multi-byte character
 * introduced by starting mid-file.
 */
function locateEvents(buffer: Buffer, start: number, reachedStart: boolean): LocatedEvent[] {
  const events: LocatedEvent[] = [];
  const lines = buffer.toString('utf8').split('\n');
  let offset = start;

  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1; // the newline that split() removed

    if (index === 0 && !reachedStart) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      events.push({ event: JSON.parse(trimmed) as TranscriptEvent, offset: lineStart });
    } catch {
      // A partially flushed trailing line is expected while a session is live.
    }
  }

  return events;
}
