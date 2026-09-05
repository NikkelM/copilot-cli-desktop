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
    expect(await readTranscript('missing')).toEqual({ events: [], truncated: false });
  });

  it('handles an empty log', async () => {
    writeLog('s', []);
    const { readTranscript } = await loadEventLog();
    expect(await readTranscript('s')).toEqual({ events: [], truncated: false });
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
