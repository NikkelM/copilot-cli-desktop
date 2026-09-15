import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

function writeLog(sessionId: string, lines: string[]): void {
  const dir = join(home, 'session-state', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n'));
}

const line = (index: number) => JSON.stringify({ type: 'user.message', data: { content: `m${index}` } });

/** paths.ts reads COPILOT_HOME once at import, so the module cache must be cleared. */
async function loadEventLog() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./eventLog.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccd-log-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

describe('readTranscript', () => {
  it('returns nothing when the session has no log', async () => {
    const { readTranscript } = await loadEventLog();
    expect(await readTranscript('missing')).toEqual({ events: [], truncated: false, nextBefore: null });
  });

  it('handles an empty log', async () => {
    writeLog('s', []);
    const { readTranscript } = await loadEventLog();
    expect(await readTranscript('s')).toEqual({ events: [], truncated: false, nextBefore: null });
  });

  it('returns every event when the log is short, in order', async () => {
    writeLog('s', [line(1), line(2), line(3), '']);
    const { readTranscript } = await loadEventLog();

    const result = await readTranscript('s');
    expect(result.events.map((e) => (e.data as { content: string }).content)).toEqual(['m1', 'm2', 'm3']);
    expect(result.truncated).toBe(false);
  });

  it('keeps the newest events and reports truncation', async () => {
    writeLog(
      's',
      Array.from({ length: 50 }, (_, i) => line(i)),
    );
    const { readTranscript } = await loadEventLog();

    const result = await readTranscript('s', 10);
    expect(result.events).toHaveLength(10);
    expect((result.events[0]?.data as { content: string }).content).toBe('m40');
    expect((result.events[9]?.data as { content: string }).content).toBe('m49');
    expect(result.truncated).toBe(true);
  });

  /**
   * Half of a real page is events the transcript has no case for and silently drops, and
   * the biggest of them carries the whole system prompt. Sending them costs a serialise,
   * two process boundaries and a parse to produce nothing.
   */  /**
   * A subagent's work is another agent's conversation, and it dominates a delegating
   * session: measured across real logs it is 4% to 73% of the drawable events and up to
   * 73% of their bytes. It carries an agentId, which the root agent's events never do.
   */
  describe('the work a subagent did', () => {
    const delegating = [
      JSON.stringify({ type: 'user.message', data: { content: 'delegate this' } }),
      JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'task', toolCallId: 'call-1' } }),
      JSON.stringify({ type: 'subagent.started', agentId: 'agent-1', data: { toolCallId: 'call-1', agentName: 'explore' } }),
      JSON.stringify({ type: 'assistant.message', agentId: 'agent-1', data: { content: 'the subagent thinking aloud' } }),
      JSON.stringify({ type: 'tool.execution_start', agentId: 'agent-1', data: { toolName: 'grep' } }),
      JSON.stringify({ type: 'tool.execution_complete', agentId: 'agent-1', data: { output: 'x'.repeat(4000) } }),
      JSON.stringify({ type: 'subagent.completed', agentId: 'agent-1', data: { toolCallId: 'call-1', agentName: 'explore' } }),
      JSON.stringify({ type: 'assistant.message', data: { content: 'the answer' } }),
    ];

    it('stays out of the parent transcript', async () => {
      writeLog('s', delegating);
      const { readTranscript } = await loadEventLog();

      const contents = (await readTranscript('s')).events.map((e) => (e.data as { content?: string }).content);
      expect(contents).not.toContain('the subagent thinking aloud');
    });

    /** The parent still has to say a task was delegated and how it went. */
    it('keeps the lifecycle, which is what the delegating row reports', async () => {
      writeLog('s', delegating);
      const { readTranscript } = await loadEventLog();

      expect((await readTranscript('s')).events.map((e) => e.type)).toEqual([
        'user.message',
        'tool.execution_start',
        'subagent.started',
        'subagent.completed',
        'assistant.message',
      ]);
    });

    it('keeps the parent conversation whole', async () => {
      writeLog('s', delegating);
      const { readTranscript } = await loadEventLog();

      const contents = (await readTranscript('s')).events.map((e) => (e.data as { content?: string }).content);
      expect(contents).toContain('delegate this');
      expect(contents).toContain('the answer');
    });

    /**
     * The case that forced the budget to count visible events. This session's newest
     * hundred and fifty were all one subagent's, so a page counted in raw events contained
     * nothing the reader could see at all.
     */
    it('reads past a run of subagent work rather than returning an empty page', async () => {
      writeLog('s', delegating);
      const { readTranscript } = await loadEventLog();

      const page = await readTranscript('s', 3);
      expect(page.events.map((e) => e.type)).toEqual([
        'subagent.started',
        'subagent.completed',
        'assistant.message',
      ]);
    });

    it('leaves a failed subagent to report itself as well', async () => {
      writeLog('s', [
        JSON.stringify({ type: 'subagent.failed', agentId: 'agent-1', data: { toolCallId: 'call-1' } }),
      ]);
      const { readTranscript } = await loadEventLog();

      expect((await readTranscript('s')).events.map((e) => e.type)).toEqual(['subagent.failed']);
    });
  });
  describe('events the transcript cannot draw', () => {
    /** A system prompt is the expensive one: measured at up to 305 KB in a single page. */
    const noisy = [
      JSON.stringify({ type: 'user.message', data: { content: 'asked' } }),
      JSON.stringify({ type: 'system.message', data: { content: 'x'.repeat(2000) } }),
      JSON.stringify({ type: 'hook.start', data: {} }),
      JSON.stringify({ type: 'assistant.turn_start', data: {} }),
      JSON.stringify({ type: 'assistant.message', data: { content: 'answered' } }),
      JSON.stringify({ type: 'assistant.turn_end', data: {} }),
      JSON.stringify({ type: 'hook.end', data: {} }),
    ];

    it('leaves them out of the page', async () => {
      writeLog('s', noisy);
      const { readTranscript } = await loadEventLog();

      const result = await readTranscript('s');
      expect(result.events.map((e) => e.type)).toEqual(['user.message', 'assistant.message']);
    });

    /**
     * The budget counts what the reader will see.
     *
     * It exists to bound what a page costs to render, and only visible events are rendered,
     * so counting the invisible ones would make a page mean different amounts of
     * conversation depending on how much traffic happened to sit in it. Asking for three
     * gives three that can be drawn, reading further back for them if it must.
     */
    it('spends the page budget on events that can be drawn', async () => {
      writeLog('s', noisy);
      const { readTranscript } = await loadEventLog();

      const result = await readTranscript('s', 3);
      expect(result.events.map((e) => e.type)).toEqual(['user.message', 'assistant.message']);
    });

    // Paging steps over what was dropped rather than reading it again next time.
    it('pages from the oldest event it returned', async () => {
      writeLog('s', [...noisy, JSON.stringify({ type: 'assistant.message', data: { content: 'newest' } })]);
      const { readTranscript } = await loadEventLog();

      const page = await readTranscript('s', 1);
      expect(page.events.map((e) => e.type)).toEqual(['assistant.message']);

      const older = await readTranscript('s', 10, page.nextBefore ?? undefined);
      expect(older.events.map((e) => e.type)).toEqual(['user.message', 'assistant.message']);
    });

    it('says nothing is left when a page holds none it can draw', async () => {
      writeLog('s', [JSON.stringify({ type: 'system.message', data: { content: 'only this' } })]);
      const { readTranscript } = await loadEventLog();

      expect(await readTranscript('s')).toEqual({ events: [], truncated: false, nextBefore: null });
    });
  });

  // The read starts at a byte offset, so the first line in view is usually incomplete.
  // Growing the window past a very large log is what this guards.
  it('grows the window until it has enough events', async () => {    // Each line is padded so 500 events comfortably exceed the initial 256 KB window.
    const padded = Array.from({ length: 900 }, (_, i) =>
      JSON.stringify({ type: 'user.message', data: { content: `m${i}`, pad: 'x'.repeat(600) } }),
    );
    writeLog('s', padded);

    const { readTranscript } = await loadEventLog();
    const result = await readTranscript('s', 500);

    expect(result.events).toHaveLength(500);
    expect((result.events.at(-1)?.data as { content: string }).content).toBe('m899');
    expect((result.events[0]?.data as { content: string }).content).toBe('m400');
  });

  it('never emits a partially read line as an event', async () => {
    const padded = Array.from({ length: 900 }, (_, i) =>
      JSON.stringify({ type: 'user.message', data: { content: `m${i}`, pad: 'x'.repeat(600) } }),
    );
    writeLog('s', padded);

    const { readTranscript } = await loadEventLog();
    const result = await readTranscript('s', 20);

    // A truncated line would fail to parse and be dropped, so every event must be whole.
    for (const event of result.events) {
      expect(event.type).toBe('user.message');
      expect((event.data as { pad: string }).pad).toHaveLength(600);
    }
  });

  it('survives a partially flushed trailing line from a live session', async () => {
    writeLog('s', [line(1), line(2), '{"type":"user.mess']);
    const { readTranscript } = await loadEventLog();

    const result = await readTranscript('s');
    expect(result.events).toHaveLength(2);
  });

  it('reads multi-byte characters correctly across the window boundary', async () => {
    const events = Array.from({ length: 400 }, (_, i) =>
      JSON.stringify({ type: 'user.message', data: { content: `héllo wörld ${i} 🎉`, pad: 'ü'.repeat(400) } }),
    );
    writeLog('s', events);

    const { readTranscript } = await loadEventLog();
    const result = await readTranscript('s', 5);

    expect(result.events).toHaveLength(5);
    expect((result.events.at(-1)?.data as { content: string }).content).toBe('héllo wörld 399 🎉');
  });
});

describe('paging back through history', () => {
  const content = (event: { data: unknown }) => (event.data as { content: string }).content;

  it('reports no cursor when the whole log fits', async () => {
    writeLog('s', [line(1), line(2)]);
    const { readTranscript } = await loadEventLog();

    const result = await readTranscript('s', 10);
    expect(result.nextBefore).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('walks the entire log in pages without gaps or repeats', async () => {
    writeLog(
      's',
      Array.from({ length: 25 }, (_, i) => line(i)),
    );
    const { readTranscript } = await loadEventLog();

    const seen: string[] = [];
    let cursor: number | undefined;

    for (let page = 0; page < 10; page += 1) {
      const result = await readTranscript('s', 10, cursor);
      seen.unshift(...result.events.map(content));
      if (result.nextBefore === null) break;
      cursor = result.nextBefore;
    }

    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
  });

  // The cursor must point at the first event returned, not the window start: the window
  // begins mid-line and further events are dropped when slicing to the limit.
  it('resumes exactly where the previous page began', async () => {
    writeLog(
      's',
      Array.from({ length: 20 }, (_, i) => line(i)),
    );
    const { readTranscript } = await loadEventLog();

    const newest = await readTranscript('s', 5);
    expect(newest.events.map(content)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19']);

    const older = await readTranscript('s', 5, newest.nextBefore ?? undefined);
    expect(older.events.map(content)).toEqual(['m10', 'm11', 'm12', 'm13', 'm14']);
  });

  it('stops offering a cursor once the start of the log is reached', async () => {
    writeLog(
      's',
      Array.from({ length: 8 }, (_, i) => line(i)),
    );
    const { readTranscript } = await loadEventLog();

    const newest = await readTranscript('s', 5);
    const older = await readTranscript('s', 5, newest.nextBefore ?? undefined);

    expect(older.events.map(content)).toEqual(['m0', 'm1', 'm2']);
    expect(older.nextBefore).toBeNull();
    expect(older.truncated).toBe(false);
  });

  it('pages correctly when the window has to grow', async () => {
    const padded = Array.from({ length: 700 }, (_, i) =>
      JSON.stringify({ type: 'user.message', data: { content: `m${i}`, pad: 'x'.repeat(600) } }),
    );
    writeLog('s', padded);

    const { readTranscript } = await loadEventLog();
    const newest = await readTranscript('s', 500);
    expect(content(newest.events[0]!)).toBe('m200');

    const older = await readTranscript('s', 500, newest.nextBefore ?? undefined);
    expect(older.events.map(content)).toEqual(Array.from({ length: 200 }, (_, i) => `m${i}`));
    expect(older.nextBefore).toBeNull();
  });
});

/**
 * What a session runs on, without starting anything to ask.
 *
 * The model is only ever mentioned in the log, and where in the log varies: a change lands
 * wherever it happened, while the run's opening line always names one.
 */
describe('lastModel', () => {
  const start = (model: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'session.start', data: { selectedModel: model, ...extra } });
  const change = (model: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'session.model_change', data: { newModel: model, ...extra } });

  it('says nothing for a session with no log', async () => {
    const { lastModel } = await loadEventLog();
    expect(await lastModel('never-run')).toBeNull();
  });

  it('reads the model the run opened with', async () => {
    writeLog('s1', [start('claude-opus-5', { reasoningEffort: 'max', contextTier: 'long_context' }), line(1)]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toEqual({
      model: 'claude-opus-5',
      reasoningEffort: 'max',
      contextTier: 'long_context',
    });
  });

  it('prefers a later change to the model it opened with', async () => {
    writeLog('s1', [start('gpt-5.4'), line(1), change('claude-opus-5', { reasoningEffort: 'high' }), line(2)]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toMatchObject({ model: 'claude-opus-5', reasoningEffort: 'high' });
  });

  it('takes the last of several changes', async () => {
    writeLog('s1', [start('gpt-5.4'), change('grok-4.6'), change('claude-opus-5'), line(1)]);
    const { lastModel } = await loadEventLog();

    expect((await lastModel('s1'))?.model).toBe('claude-opus-5');
  });

  // An older CLI wrote the opening line without naming a model, and stopping at it would
  // miss the change on the very next line.
  it('looks past an opening line that names nothing', async () => {
    writeLog('s1', [JSON.stringify({ type: 'session.start', data: {} }), change('claude-opus-4.8'), line(1)]);
    const { lastModel } = await loadEventLog();

    expect((await lastModel('s1'))?.model).toBe('claude-opus-4.8');
  });

  // Neither a change nor an opening line reliably carries all three, so reading only the
  // newest event that names a model dropped whatever that event left out.
  it('assembles the model, the effort and the context from separate events', async () => {
    writeLog('s1', [
      start('gpt-5.4', { contextTier: 'long_context' }),
      line(1),
      change('claude-opus-5', { reasoningEffort: 'max' }),
      line(2),
    ]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toEqual({
      model: 'claude-opus-5',
      reasoningEffort: 'max',
      contextTier: 'long_context',
    });
  });

  it('takes the newest mention of each part', async () => {
    writeLog('s1', [
      start('gpt-5.4', { reasoningEffort: 'low', contextTier: 'default' }),
      change('claude-opus-5', { reasoningEffort: 'max' }),
    ]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toMatchObject({ reasoningEffort: 'max', contextTier: 'default' });
  });

  // The runtime writes null for a setting nobody chose, and null is not a value to show.
  it('treats a setting written as null as unset', async () => {
    writeLog('s1', [start('claude-opus-5', { reasoningEffort: null, contextTier: null })]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toEqual({ model: 'claude-opus-5', reasoningEffort: undefined, contextTier: undefined });
  });

  // The opening line sometimes carries the context and no model at all, which is only
  // useful if it is still read for the part it does have.
  it('takes the context from an opening line that names no model', async () => {
    writeLog('s1', [start(undefined as unknown as string, { contextTier: 'long_context' }), change('claude-opus-4.8')]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toMatchObject({ model: 'claude-opus-4.8', contextTier: 'long_context' });
  });

  // The tail is where a recent change is, but it rarely mentions the context, which is set
  // once at the top of the run and never again.
  it('fills in from the opening line when a long tail leaves parts out', async () => {
    const filler = Array.from({ length: 4000 }, (_, index) => line(index));
    writeLog('s1', [start('gpt-5.4', { contextTier: 'long_context' }), ...filler, change('claude-opus-5', { reasoningEffort: 'high' })]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toEqual({
      model: 'claude-opus-5',
      reasoningEffort: 'high',
      contextTier: 'long_context',
    });
  });
  it('says nothing when the log never names a model', async () => {
    writeLog('s1', [line(1), line(2)]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toBeNull();
  });

  /**
   * The case the tail scan alone got wrong: one real log here is 300 MB with no mention of
   * its model in the last 32 MB, because nothing about it changed for the whole run. Read
   * only from the end, such a session says nothing at all about what it runs on.
   */
  it('falls back to the opening line when the tail is only conversation', async () => {
    const filler = Array.from({ length: 4000 }, (_, index) => line(index));
    writeLog('s1', [start('claude-opus-5', { contextTier: 'long_context' }), ...filler]);
    const { lastModel } = await loadEventLog();

    expect(await lastModel('s1')).toMatchObject({ model: 'claude-opus-5', contextTier: 'long_context' });
  });

  it('still prefers a change buried in a long tail', async () => {
    const filler = Array.from({ length: 4000 }, (_, index) => line(index));
    writeLog('s1', [start('gpt-5.4'), ...filler, change('claude-opus-5'), ...filler]);
    const { lastModel } = await loadEventLog();

    expect((await lastModel('s1'))?.model).toBe('claude-opus-5');
  });

  it('reads a resume the same way as a start', async () => {
    writeLog('s1', [
      start('gpt-5.4'),
      JSON.stringify({ type: 'session.resume', data: { selectedModel: 'claude-opus-5' } }),
      line(1),
    ]);
    const { lastModel } = await loadEventLog();

    expect((await lastModel('s1'))?.model).toBe('claude-opus-5');
  });
});

describe('lastAgent', () => {
  const selected = (name: string, displayName?: string) =>
    JSON.stringify({
      type: 'subagent.selected',
      data: { agentName: name, ...(displayName ? { agentDisplayName: displayName } : {}) },
    });
  const deselected = () => JSON.stringify({ type: 'subagent.deselected', data: {} });

  it('says nothing for a session with no log', async () => {
    const { lastAgent } = await loadEventLog();
    expect(await lastAgent('never-run')).toBeNull();
  });

  it('handles an empty log', async () => {
    writeLog('s1', []);
    const { lastAgent } = await loadEventLog();
    expect(await lastAgent('s1')).toBeNull();
  });

  it('says nothing for a session that never chose an agent', async () => {
    writeLog('s1', [line(1), line(2), line(3)]);
    const { lastAgent } = await loadEventLog();

    expect(await lastAgent('s1')).toBeNull();
  });

  it('reads the agent a session was put on', async () => {
    writeLog('s1', [line(1), selected('deep-audit', 'Deep Audit'), line(2)]);
    const { lastAgent } = await loadEventLog();

    expect(await lastAgent('s1')).toEqual({ name: 'deep-audit', displayName: 'Deep Audit' });
  });

  it('shows the name when the event carries no display name', async () => {
    writeLog('s1', [selected('deep-audit'), line(1)]);
    const { lastAgent } = await loadEventLog();

    expect(await lastAgent('s1')).toEqual({ name: 'deep-audit', displayName: 'deep-audit' });
  });

  it('takes the last of several selections', async () => {
    writeLog('s1', [selected('first'), line(1), selected('second'), line(2), selected('third')]);
    const { lastAgent } = await loadEventLog();

    expect((await lastAgent('s1'))?.name).toBe('third');
  });

  // The distinction the wrapper in latestAgentIn exists for: without it the deselection reads
  // as nothing to say and the scan carries on to the selection it undid.
  it('treats a later deselection as the default agent rather than a miss', async () => {
    writeLog('s1', [selected('deep-audit'), line(1), deselected(), line(2)]);
    const { lastAgent } = await loadEventLog();

    expect(await lastAgent('s1')).toBeNull();
  });

  it('prefers a selection made after a deselection', async () => {
    writeLog('s1', [selected('first'), deselected(), line(1), selected('second')]);
    const { lastAgent } = await loadEventLog();

    expect((await lastAgent('s1'))?.name).toBe('second');
  });

  it('ignores a selection event that names no agent', async () => {
    writeLog('s1', [selected('deep-audit'), JSON.stringify({ type: 'subagent.selected', data: {} })]);
    const { lastAgent } = await loadEventLog();

    expect((await lastAgent('s1'))?.name).toBe('deep-audit');
  });

  it('finds a selection buried behind a lot of events', async () => {
    const filler = Array.from({ length: 4000 }, (_, index) => line(index));
    writeLog('s1', [...filler, selected('deep-audit'), ...filler]);
    const { lastAgent } = await loadEventLog();

    expect((await lastAgent('s1'))?.name).toBe('deep-audit');
  });

  // The second read of the opening, which is reachable only for a log too long for the tail
  // scan to reach the selection. Fat lines rather than many, so the file passes the 32 MB
  // ceiling without the cost of parsing a million of them.
  it('reads the opening when the tail is too long to scan to the selection', async () => {
    const fat = JSON.stringify({ type: 'user.message', data: { content: 'x'.repeat(5000) } });
    const dir = join(home, 'session-state', 'huge');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), `${selected('deep-audit')}\n${`${fat}\n`.repeat(6800)}`);

    const { lastAgent } = await loadEventLog();
    expect((await lastAgent('huge'))?.name).toBe('deep-audit');
  }, 30_000);
});

/**
 * Unlike a model or an agent, absence is an answer here: a session opens in `interactive`
 * and records nothing to say so, so there is no opening line to fall back on and nothing
 * found means the default rather than "not known".
 */
describe('lastMode', () => {
  const changed = (newMode: string, previousMode = 'interactive') =>
    JSON.stringify({ type: 'session.mode_changed', data: { previousMode, newMode } });

  it('says interactive for a session with no log', async () => {
    const { lastMode } = await loadEventLog();
    expect(await lastMode('never-run')).toBe('interactive');
  });

  it('handles an empty log', async () => {
    writeLog('s1', []);
    const { lastMode } = await loadEventLog();
    expect(await lastMode('s1')).toBe('interactive');
  });

  // Which is almost every session: only one log on this machine has a mode event at all.
  it('says interactive for a session that never changed mode', async () => {
    writeLog('s1', [line(1), line(2), line(3)]);
    const { lastMode } = await loadEventLog();

    expect(await lastMode('s1')).toBe('interactive');
  });

  it('reads the mode a session was put into', async () => {
    writeLog('s1', [line(1), changed('plan'), line(2)]);
    const { lastMode } = await loadEventLog();

    expect(await lastMode('s1')).toBe('plan');
  });

  it('takes the last of several changes', async () => {
    writeLog('s1', [changed('plan'), line(1), changed('autopilot', 'plan'), line(2), changed('interactive', 'autopilot')]);
    const { lastMode } = await loadEventLog();

    expect(await lastMode('s1')).toBe('interactive');
  });

  /**
   * A mode this build does not know is not a reason to give up: an older change to one it
   * does know still describes the session better than the default does. `shell` is the real
   * case - the SDK records it as an agent mode without it being a session mode.
   */
  it('keeps looking past a mode it does not know', async () => {
    writeLog('s1', [changed('plan'), line(1), changed('shell', 'plan')]);
    const { lastMode } = await loadEventLog();

    expect(await lastMode('s1')).toBe('plan');
  });

  it('ignores a change event that names no mode', async () => {
    writeLog('s1', [changed('autopilot'), JSON.stringify({ type: 'session.mode_changed', data: {} })]);
    const { lastMode } = await loadEventLog();

    expect(await lastMode('s1')).toBe('autopilot');
  });

  it('finds a change buried behind a lot of events', async () => {
    const filler = Array.from({ length: 4000 }, (_, index) => line(index));
    writeLog('s1', [...filler, changed('autopilot'), ...filler]);
    const { lastMode } = await loadEventLog();

    expect(await lastMode('s1')).toBe('autopilot');
  });

  /**
   * The bounded read giving up, which is the trade this makes deliberately. Being wrong
   * costs a label that says interactive until the session is loaded, at which point the
   * runtime answers instead.
   */
  it('falls back to interactive when the change is beyond the scan', async () => {
    const fat = JSON.stringify({ type: 'user.message', data: { content: 'x'.repeat(5000) } });
    const dir = join(home, 'session-state', 'huge-mode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), `${changed('autopilot')}\n${`${fat}\n`.repeat(6800)}`);

    const { lastMode } = await loadEventLog();
    expect(await lastMode('huge-mode')).toBe('interactive');
  }, 30_000);
});

/**
 * What a session spent, read from its log so that a session nobody has opened can still
 * account for itself. The checkpoint carries exactly the two running totals that
 * `usage.getMetrics` reports for a resumed session, verified against two real sessions.
 */
describe('lastUsage', () => {
  const checkpoint = (totalPremiumRequests: number, totalNanoAiu: number) =>
    JSON.stringify({ type: 'session.usage_checkpoint', data: { totalPremiumRequests, totalNanoAiu } });

  it('says nothing for a session with no log', async () => {
    const { lastUsage } = await loadEventLog();
    expect(await lastUsage('never-run')).toBeNull();
  });

  it('says nothing for an empty log', async () => {
    writeLog('s', []);
    const { lastUsage } = await loadEventLog();
    expect(await lastUsage('s')).toBeNull();
  });

  // A session that has not finished a turn has written no checkpoint, and zero would claim
  // it cost nothing rather than that nothing is recorded.
  it('says nothing when no checkpoint has been written yet', async () => {
    writeLog('s', [line(1), line(2)]);
    const { lastUsage } = await loadEventLog();
    expect(await lastUsage('s')).toBeNull();
  });

  it('reports the totals, converting the nano units the runtime counts in', async () => {
    writeLog('s', [line(1), checkpoint(390, 1_057_768_750_000)]);
    const { lastUsage } = await loadEventLog();

    expect(await lastUsage('s')).toEqual({ premiumRequests: 390, aiu: 1057.76875, loaded: false });
  });

  // Each checkpoint supersedes the one before it: they are running totals, not increments.
  it('takes the newest checkpoint rather than adding them up', async () => {
    writeLog('s', [checkpoint(10, 1_000_000_000), checkpoint(45, 2_048_175_675_000)]);
    const { lastUsage } = await loadEventLog();

    expect(await lastUsage('s')).toMatchObject({ premiumRequests: 45 });
  });

  it('marks it as not having come from a loaded session', async () => {
    writeLog('s', [checkpoint(1, 0)]);
    const { lastUsage } = await loadEventLog();

    expect((await lastUsage('s'))?.loaded).toBe(false);
  });

  /** A checkpoint carrying neither total describes nothing, so an older one still wins. */
  it('looks past a checkpoint with no totals in it', async () => {
    writeLog('s', [checkpoint(7, 3_000_000_000), JSON.stringify({ type: 'session.usage_checkpoint', data: {} })]);
    const { lastUsage } = await loadEventLog();

    expect(await lastUsage('s')).toMatchObject({ premiumRequests: 7 });
  });

  it('reads one total when the other is missing', async () => {
    writeLog('s', [JSON.stringify({ type: 'session.usage_checkpoint', data: { totalPremiumRequests: 12 } })]);
    const { lastUsage } = await loadEventLog();

    expect(await lastUsage('s')).toEqual({ premiumRequests: 12, aiu: 0, loaded: false });
  });

  // The checkpoint is near the end of a live session's log but not at it, so the read has
  // to grow its window the way the other cold reads do.
  it('grows the window to reach a checkpoint behind a wall of newer events', async () => {
    const fat = JSON.stringify({ type: 'user.message', data: { content: 'x'.repeat(4000) } });
    writeLog('s', [checkpoint(99, 5_000_000_000), ...Array.from({ length: 400 }, () => fat)]);

    const { lastUsage } = await loadEventLog();
    expect(await lastUsage('s')).toMatchObject({ premiumRequests: 99 });
  }, 30_000);
});
