import { describe, expect, it } from 'vitest';

import { appendLive, intentOf, timelineOf, type TimelineEvent } from './timeline';

const intended = (intent: unknown): TimelineEvent =>
  ({ type: 'assistant.intent', data: { intent } }) as unknown as TimelineEvent;

describe('intentOf', () => {
  it('reads what the agent says it is doing', () => {
    expect(intentOf(intended('Reading the runtime'))).toBe('Reading the runtime');
  });

  // Nothing else on the stream describes the current activity, so a near miss is not one.
  it('ignores any other event', () => {
    expect(intentOf({ type: 'assistant.message', data: { intent: 'nope' } } as unknown as TimelineEvent)).toBeNull();
  });

  it('trims what it is given', () => {
    expect(intentOf(intended('  Running the tests\n'))).toBe('Running the tests');
  });

  // An empty description is the same as none: the line falls back to "Working" rather than
  // showing a spinner with a gap beside it.
  it('treats an empty description as nothing said', () => {
    expect(intentOf(intended('   '))).toBeNull();
  });

  it('survives a description that is not text', () => {
    expect(intentOf(intended(42))).toBeNull();
    expect(intentOf(intended(undefined))).toBeNull();
  });
});

const said = (content: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  type: 'user.message',
  data: { content },
  ...extra,
});

const replied = (content: string): TimelineEvent => ({ type: 'assistant.message', data: { content } });

describe('appendLive', () => {
  it('adds an event to the end', () => {
    expect(appendLive([replied('one')], replied('two'))).toEqual([replied('one'), replied('two')]);
  });

  // The prompt is shown before the runtime confirms it, so the echo must land on the
  // entry already there rather than beside it.
  it('replaces the optimistic prompt with the echo of the same message', () => {
    const optimistic = said('hello', { local: true, id: 'local-1' });
    const echo = said('hello', { id: 'server-1' });

    const next = appendLive([replied('earlier'), optimistic], echo);

    expect(next).toHaveLength(2);
    expect(next[1]).toBe(echo);
  });

  it('keeps a prompt that says something else', () => {
    const optimistic = said('hello', { local: true });
    expect(appendLive([optimistic], said('goodbye'))).toHaveLength(2);
  });

  // Only the app's own entries are placeholders; a replayed message is history.
  it('does not fold an echo into an identical message from the log', () => {
    expect(appendLive([said('hello')], said('hello'))).toHaveLength(2);
  });
});

describe('timelineOf', () => {
  it('puts everything since selection after the replayed history', () => {
    expect(timelineOf([replied('old')], [said('new')])).toEqual([replied('old'), said('new')]);
  });

  /**
   * The bug behind #71. A replay describes the log at the moment it was requested, so
   * when the two lists were one, a reply that arrived after the user had already typed
   * overwrote the prompt, which then reappeared only when the session was reopened.
   */
  it('survives history arriving after the user has already sent something', () => {
    const prompt = said('do the thing', { local: true });

    // The user sends while the replay is still in flight.
    let live = appendLive([], prompt);
    // The replay lands, describing a log recorded before that prompt existed.
    const history = [replied('from the log')];

    expect(timelineOf(history, live)).toEqual([replied('from the log'), prompt]);

    // And the runtime's echo still finds the prompt to replace.
    const echo = said('do the thing');
    live = appendLive(live, echo);
    expect(timelineOf(history, live)).toEqual([replied('from the log'), echo]);
  });

  it('holds live events through a page of older history being prepended', () => {
    const live = [said('recent', { local: true })];
    const history = [replied('page two')];
    const older = [replied('page one')];

    expect(timelineOf([...older, ...history], live)).toEqual([
      replied('page one'),
      replied('page two'),
      said('recent', { local: true }),
    ]);
  });
});

// Deltas are ephemeral: they never reach the log, so they only ever appear live.
describe('streaming a reply', () => {
  const delta = (messageId: string, deltaContent: string): TimelineEvent => ({
    type: 'assistant.message_delta',
    data: { messageId, deltaContent },
  });
  const whole = (messageId: string, content: string): TimelineEvent => ({
    type: 'assistant.message',
    data: { messageId, content },
  });

  it('grows one event rather than collecting hundreds', () => {
    let live: TimelineEvent[] = [];
    for (const chunk of ['The', ' sea', ' keeps', ' its own time']) live = appendLive(live, delta('m1', chunk));

    expect(live).toHaveLength(1);
    expect(live[0]!.data).toEqual({ messageId: 'm1', deltaContent: 'The sea keeps its own time' });
  });

  it('replaces the run with the finished message instead of repeating it', () => {
    let live = appendLive([], delta('m1', 'partial'));
    live = appendLive(live, whole('m1', 'partial and then some'));

    expect(live).toHaveLength(1);
    expect(live[0]!.type).toBe('assistant.message');
  });

  it('keeps replies apart when one message follows another', () => {
    let live = appendLive([], delta('m1', 'first'));
    live = appendLive(live, whole('m1', 'first'));
    live = appendLive(live, delta('m2', 'second'));

    expect(live.map((e) => e.type)).toEqual(['assistant.message', 'assistant.message_delta']);
  });

  it('leaves anything arriving between a reply and its deltas alone', () => {
    let live = appendLive([], delta('m1', 'thinking'));
    live = appendLive(live, { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'grep' } });
    live = appendLive(live, delta('m1', ' more'));

    expect(live).toHaveLength(2);
    expect(live[0]!.data).toMatchObject({ deltaContent: 'thinking more' });
    expect(live[1]!.type).toBe('tool.execution_start');
  });
});

describe('thinking arriving live', () => {
  const chunk = (reasoningId: string, deltaContent: string): TimelineEvent => ({
    type: 'assistant.reasoning_delta',
    data: { reasoningId, deltaContent },
  });

  it('grows one event rather than collecting hundreds', () => {
    let live: TimelineEvent[] = [];
    for (const part of ['I should ', 'look at ', 'the file']) live = appendLive(live, chunk('r1', part));

    expect(live).toHaveLength(1);
    expect(live[0]!.data).toEqual({ reasoningId: 'r1', deltaContent: 'I should look at the file' });
  });

  it('keeps separate blocks of thinking apart', () => {
    let live = appendLive([], chunk('r1', 'first'));
    live = appendLive(live, chunk('r2', 'second'));

    expect(live).toHaveLength(2);
  });

  /**
   * The complete block arrives after the chunks that built it, saying the same thing. Two
   * rows of identical thinking appeared in the app before this.
   */
  it('replaces the chunks with the finished block rather than showing both', () => {
    let live = appendLive([], chunk('r1', 'I should look'));
    live = appendLive(live, { type: 'assistant.reasoning', data: { reasoningId: 'r1', content: 'I should look' } });

    expect(live).toHaveLength(1);
    expect(live[0]!.type).toBe('assistant.reasoning');
  });

  it('keeps a finished block that had no chunks before it', () => {
    const live = appendLive([], { type: 'assistant.reasoning', data: { reasoningId: 'r1', content: 'thought' } });
    expect(live).toHaveLength(1);
  });
});

/**
 * A running tool's output. The runtime resends everything produced so far each time, so
 * the newest event replaces the one before it rather than being folded into it.
 */
describe('a running tool reporting what it has produced', () => {
  const chunk = (toolCallId: string, partialOutput: string): TimelineEvent => ({
    type: 'tool.execution_partial_result',
    data: { toolCallId, partialOutput },
  });

  it('keeps one event rather than one per chunk', () => {
    let live: TimelineEvent[] = [];
    for (const soFar of ['line 1', 'line 1\nline 2', 'line 1\nline 2\nline 3']) {
      live = appendLive(live, chunk('t1', soFar));
    }

    expect(live).toHaveLength(1);
  });

  /**
   * The payload is cumulative despite being called `partialOutput`, and despite the SDK
   * documenting it as "incremental output chunk". Verified against the runtime: a
   * twelve-second command sent thirteen of these, each carrying all the output so far.
   * Folding them the way message deltas are folded would repeat every line.
   */
  it('shows the latest output rather than every chunk joined together', () => {
    let live = appendLive([], chunk('t1', 'line 1'));
    live = appendLive(live, chunk('t1', 'line 1\nline 2'));

    expect(live[0]!.data).toMatchObject({ partialOutput: 'line 1\nline 2' });
  });

  it('keeps two tools running at once apart', () => {
    let live = appendLive([], chunk('t1', 'from one'));
    live = appendLive(live, chunk('t2', 'from two'));

    expect(live).toHaveLength(2);
  });

  // It sits where the tool started, so its output is read as part of that tool's row and
  // not after whatever the agent said while it was running.
  it('stays where it was rather than jumping to the end', () => {
    let live = appendLive([], chunk('t1', 'first'));
    live = appendLive(live, { type: 'assistant.message', data: { content: 'meanwhile' } });
    live = appendLive(live, chunk('t1', 'first\nsecond'));

    expect(live.map((e) => e.type)).toEqual(['tool.execution_partial_result', 'assistant.message']);
  });
});
