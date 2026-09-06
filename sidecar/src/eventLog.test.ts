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

  // The read starts at a byte offset, so the first line in view is usually incomplete.
  // Growing the window past a very large log is what this guards.
  it('grows the window until it has enough events', async () => {
    // Each line is padded so 500 events comfortably exceed the initial 256 KB window.
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
