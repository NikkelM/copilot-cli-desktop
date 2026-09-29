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
    expect(await readTranscript('s')).toEqual({
      events: [],
      truncated: false,
      nextBefore: null,
      // Nothing written yet is a session that is new, not one that has lost anything.
      reopenable: true,
    });
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
   */     /**
    * A subagent's work is carried, not dropped: the transcript nests it inside the row that
    * delegated it, so a delegating turn can be watched as it happens. What the read still
    * owes is the ordering and the lifecycle that make that nesting possible (#11).
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

     it('carries it, for the delegating row to nest', async () => {
       writeLog('s', delegating);
       const { readTranscript } = await loadEventLog();

       const contents = (await readTranscript('s')).events.map((e) => (e.data as { content?: string }).content);
       expect(contents).toContain('the subagent thinking aloud');
     });

     /** Which subagent an event belongs to is the only thing that can nest it. */
     it('keeps the mark that says whose work it is', async () => {
       writeLog('s', delegating);
       const { readTranscript } = await loadEventLog();

       const inner = (await readTranscript('s')).events.find(
         (e) => (e.data as { content?: string }).content === 'the subagent thinking aloud',
       );
       expect(inner?.agentId).toBe('agent-1');
     });

     it('keeps the lifecycle, which is what the delegating row reports', async () => {
       writeLog('s', delegating);
       const { readTranscript } = await loadEventLog();

       const types = (await readTranscript('s')).events.map((e) => e.type);
       expect(types).toContain('subagent.started');
       expect(types).toContain('subagent.completed');
     });

     it('keeps the parent conversation whole', async () => {
       writeLog('s', delegating);
       const { readTranscript } = await loadEventLog();

       const contents = (await readTranscript('s')).events.map((e) => (e.data as { content?: string }).content);
       expect(contents).toContain('delegate this');
       expect(contents).toContain('the answer');
     });

     it('leaves a failed subagent to report itself as well', async () => {
       writeLog('s', [
         JSON.stringify({ type: 'subagent.failed', agentId: 'agent-1', data: { toolCallId: 'call-1' } }),
       ]);
       const { readTranscript } = await loadEventLog();

       expect((await readTranscript('s')).events.map((e) => e.type)).toEqual(['subagent.failed']);
     });
   });  describe('events the transcript cannot draw', () => {
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
      writeLog('s', [
        JSON.stringify({ type: 'session.start', data: {} }),
        JSON.stringify({ type: 'system.message', data: { content: 'only this' } }),
      ]);
      const { readTranscript } = await loadEventLog();

      expect(await readTranscript('s')).toEqual({
        events: [],
        truncated: false,
        nextBefore: null,
        reopenable: true,
      });
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

/**
 * Whether the CLI could open a session again, which it can only do from a log that still
 * begins where a run does.
 *
 * Worth reporting because the failure is silent otherwise: a session whose history was
 * destroyed draws an empty transcript, which is exactly what a new session looks like, and
 * the only way to find out was to write a prompt and have it refused (#196).
 *
 * The case is real rather than imagined - one log on this machine is a single fork notice,
 * 293 bytes, with every event it used to hold gone.
 */
describe('whether a session can be opened again', () => {
  const start = JSON.stringify({ type: 'session.start', data: {} });

  it('says yes for a log that begins with a run', async () => {
    writeLog('s', [start, line(1)]);
    const { readTranscript } = await loadEventLog();

    expect((await readTranscript('s')).reopenable).toBe(true);
  });

  /** A session resumed rather than started fresh carries the other one that opens a run. */
  it('says yes for a log that begins with a resume', async () => {
    writeLog('s', [JSON.stringify({ type: 'session.resume', data: {} }), line(1)]);
    const { readTranscript } = await loadEventLog();

    expect((await readTranscript('s')).reopenable).toBe(true);
  });

  // What a destroyed session actually looks like: the notice, and nothing it refers to.
  it('says no for a log rewritten down to a fork notice', async () => {
    writeLog('s', [
      JSON.stringify({ type: 'session.info', data: { infoType: 'fork', message: 'Forked this session' } }),
    ]);
    const { readTranscript } = await loadEventLog();

    expect((await readTranscript('s')).reopenable).toBe(false);
  });

  it('still hands back what is left of one', async () => {
    writeLog('s', [JSON.stringify({ type: 'session.info', data: {} }), line(1)]);
    const { readTranscript } = await loadEventLog();

    const page = await readTranscript('s');
    expect(page.reopenable).toBe(false);
    expect(page.events).toHaveLength(1);
  });

  /**
   * Only the opening page answers. The pages behind it are the same log read further back,
   * where the first line is a window boundary rather than the start of anything.
   */
  it('says nothing on a page reached by scrolling back', async () => {
    writeLog('s', [start, line(1), line(2), line(3)]);
    const { readTranscript } = await loadEventLog();

    const first = await readTranscript('s', 1);
    expect(first.reopenable).toBe(true);
    expect((await readTranscript('s', 1, first.nextBefore ?? undefined)).reopenable).toBeUndefined();
  });

  /**
   * A log that cannot be read is not evidence of one that has lost its history, and a
   * warning on a session that is merely new would be worse than none at all.
   */
  it('says yes rather than guessing when the first line is not readable', async () => {
    writeLog('s', ['not json at all', line(1)]);
    const { readTranscript } = await loadEventLog();

    expect((await readTranscript('s')).reopenable).toBe(true);
  });

  it('says yes for a first event that does not name its type', async () => {
    writeLog('s', [JSON.stringify({ data: {} }), line(1)]);
    const { readTranscript } = await loadEventLog();

    expect((await readTranscript('s')).reopenable).toBe(true);
  });

  // A log still being written can have a partial first line, which says nothing either way.
  it('says yes for a first line still being written', async () => {
    writeLog('s', [`{"type":"session.start","data":{"padding":"${'x'.repeat(80 * 1024)}`]);
    const { readTranscript } = await loadEventLog();

    expect((await readTranscript('s')).reopenable).toBe(true);
  });
});

/**
 * Where a turn sits in a log, found by halving rather than by scanning.
 *
 * A turn index is not a position in a log, and there are more `user.message` events than
 * there are turns, so time is what the two agree on. The cursor points at where the next turn
 * begins, because the reader reads back from it - so the matched turn is what it lands on.
 */
describe('finding a turn in a log', () => {
  /** A log whose timestamps only go forwards, which is the property the halving relies on. */
  const timed = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      JSON.stringify({
        type: 'user.message',
        timestamp: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
        data: { content: `m${index}` },
      }),
    );

  it('lands on the event a moment names', async () => {
    writeLog('s', timed(600));
    const { locateTurn, readTranscript } = await loadEventLog();

    const cursor = await locateTurn('s', '2026-01-01T00:05:00.000Z');
    const page = await readTranscript('s', 1, cursor!);

    // Reading back one event from the cursor gives the event just before it, which is m299.
    expect(page.events[0]?.data).toEqual({ content: 'm299' });
  });

  it('reads the end of the log for a turn nothing follows', async () => {
    writeLog('s', timed(20));
    const { locateTurn } = await loadEventLog();

    const cursor = await locateTurn('s', null);

    expect(cursor).toBe(timed(20).join('\n').length);
  });

  // A truncated log holds none of the turn, and stopping at the end is the honest answer.
  it('reads to the end when the moment is past everything in the log', async () => {
    writeLog('s', timed(20));
    const { locateTurn } = await loadEventLog();

    const cursor = await locateTurn('s', '2099-01-01T00:00:00.000Z');

    expect(cursor).toBe(timed(20).join('\n').length);
  });

  it('lands at the very start for a moment before anything happened', async () => {
    writeLog('s', timed(40));
    const { locateTurn } = await loadEventLog();

    expect(await locateTurn('s', '2020-01-01T00:00:00.000Z')).toBe(0);
  });

  it('has nowhere to point in a log that is not there', async () => {
    const { locateTurn } = await loadEventLog();
    expect(await locateTurn('missing', '2026-01-01T00:00:00.000Z')).toBeNull();
  });

  it('has nowhere to point in an empty log', async () => {
    writeLog('s', []);
    const { locateTurn } = await loadEventLog();
    expect(await locateTurn('s', '2026-01-01T00:00:00.000Z')).toBeNull();
  });

  /**
   * The search has to cope with a window holding no whole event at all, which is what a log
   * of very long events looks like: the window grows until one fits.
   */
  it('finishes on a log of events larger than the window it reads', async () => {
    const fat = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({
        type: 'user.message',
        timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        data: { content: 'x'.repeat(80 * 1024) },
      }),
    );
    writeLog('s', fat);
    const { locateTurn, readTranscript } = await loadEventLog();

    const cursor = await locateTurn('s', '2026-01-01T00:00:06.000Z');
    const page = await readTranscript('s', 1, cursor!);

    expect((page.events[0]?.data as { content: string }).content.length).toBe(80 * 1024);
    expect(page.events[0]?.timestamp).toBe('2026-01-01T00:00:05.000Z');
  });
});

/**
 * One agent's work, read back rather than remembered (#178).
 *
 * The delegating session holds a subagent's events so the row that delegated it can draw
 * them, which grows with every delegation a session makes. The log already has all of it.
 */
describe('readAgentTranscript', () => {
  const agent = (agentId: string, type: string, content = '') =>
    JSON.stringify({ type, agentId, data: { content } });

  it('returns nothing when the session has no log', async () => {
    const { readAgentTranscript } = await loadEventLog();
    expect(await readAgentTranscript('missing', 'a1')).toEqual([]);
  });

  it('returns nothing for a log with nothing in it', async () => {
    const { readAgentTranscript } = await loadEventLog();
    writeLog('s', []);
    expect(await readAgentTranscript('s', 'a1')).toEqual([]);
  });

  it('gathers one agent own work in the order it happened', async () => {
    const { readAgentTranscript } = await loadEventLog();
    writeLog('s', [
      line(1),
      agent('a1', 'subagent.started'),
      agent('a1', 'user.message', 'go'),
      agent('a1', 'assistant.message', 'done'),
      line(2),
    ]);

    const events = await readAgentTranscript('s', 'a1');

    expect(events.map((event) => event.type)).toEqual([
      'subagent.started',
      'user.message',
      'assistant.message',
    ]);
  });

  /** The whole point of the id: two runs in one log are two different transcripts. */
  it('tells one agent work from another', async () => {
    const { readAgentTranscript } = await loadEventLog();
    writeLog('s', [
      agent('a1', 'subagent.started'),
      agent('a1', 'assistant.message', 'mine'),
      agent('a2', 'subagent.started'),
      agent('a2', 'assistant.message', 'theirs'),
    ]);

    const events = await readAgentTranscript('s', 'a1');

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.agentId === 'a1')).toBe(true);
  });

  // The session's own conversation is the parent's, and is not this agent's work.
  it('leaves the session own events out of it', async () => {
    const { readAgentTranscript } = await loadEventLog();
    writeLog('s', [line(1), agent('a1', 'subagent.started'), line(2), agent('a1', 'assistant.message', 'x'), line(3)]);

    expect(await readAgentTranscript('s', 'a1')).toHaveLength(2);
  });

  it('has nothing to say about an agent that never ran here', async () => {
    const { readAgentTranscript } = await loadEventLog();
    writeLog('s', [line(1), agent('a1', 'subagent.started')]);

    expect(await readAgentTranscript('s', 'other')).toEqual([]);
  });

  /**
   * A run is contiguous, so reaching the announcement that opened it means everything it
   * did is already behind us - which is what keeps this proportional to the run rather
   * than to a log that reaches hundreds of megabytes.
   */
  it('reaches back past a window full of somebody else conversation', async () => {
    const { readAgentTranscript } = await loadEventLog();
    // Comfortably past the first window, so the read has to grow to find the run at all.
    const filler = Array.from({ length: 4000 }, (_, at) =>
      JSON.stringify({ type: 'user.message', data: { content: `m${at} ${'.'.repeat(200)}` } }),
    );
    writeLog('s', [
      agent('a1', 'subagent.started'),
      agent('a1', 'assistant.message', 'x'.repeat(200)),
      ...filler,
    ]);

    const events = await readAgentTranscript('s', 'a1');

    expect(events.map((event) => event.type)).toEqual(['subagent.started', 'assistant.message']);
  });

  /** A run still being written has no start behind it yet, and what it has is still worth having. */
  it('returns what the log has for a run that has not been opened in it', async () => {
    const { readAgentTranscript } = await loadEventLog();
    writeLog('s', [agent('a1', 'assistant.message', 'mid-run')]);

    expect(await readAgentTranscript('s', 'a1')).toHaveLength(1);
  });
});
