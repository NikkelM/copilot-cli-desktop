import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

vi.mock('./paths.js', () => ({
  sessionEventLog: (sessionId: string) => join(home, 'session-state', sessionId, 'events.jsonl'),
}));

const { sessionPreviews, forgetPreviews } = await import('./sessionPreview.js');

/** An event line in the shape the CLI writes one. */
const said = (content: string) => JSON.stringify({ type: 'assistant.message', data: { content } });
const asked = (content: string) => JSON.stringify({ type: 'user.message', data: { content } });

function writeLog(sessionId: string, lines: string[]): string {
  const dir = join(home, 'session-state', sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'events.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'preview-'));
  forgetPreviews();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('what a session last said', () => {
  it('is the newest thing it said, not the first', () => {
    writeLog('a', [said('An older answer'), asked('And then?'), said('The newest answer')]);

    expect(sessionPreviews(['a'])).toEqual({ a: 'The newest answer' });
  });

  it('is what the assistant said rather than what was asked of it', () => {
    writeLog('a', [said('What it answered'), asked('What was asked last')]);

    expect(sessionPreviews(['a'])).toEqual({ a: 'What it answered' });
  });

  it('says nothing at all for a session that has only been asked things', () => {
    writeLog('a', [asked('Hello?'), asked('Anyone there?')]);

    expect(sessionPreviews(['a'])).toEqual({});
  });

  it('answers for several sessions at once', () => {
    writeLog('a', [said('From one')]);
    writeLog('b', [said('From the other')]);

    expect(sessionPreviews(['a', 'b'])).toEqual({ a: 'From one', b: 'From the other' });
  });

  it('skips a session that has no log without giving up on the rest', () => {
    writeLog('b', [said('Still answered')]);

    expect(sessionPreviews(['never-ran', 'b'])).toEqual({ b: 'Still answered' });
  });

  it('is asked for nothing when nothing is on screen', () => {
    expect(sessionPreviews([])).toEqual({});
  });
});

describe('reading only the tail', () => {
  it('finds the answer under a megabyte of older log', () => {
    const filler = Array.from({ length: 400 }, (_, n) => said(`Older answer ${n} ${'x'.repeat(2000)}`));
    writeLog('a', [...filler, said('The one at the end')]);

    expect(sessionPreviews(['a'])).toEqual({ a: 'The one at the end' });
  });

  it('says nothing rather than guessing when the answer is older than the window', () => {
    const tail = Array.from({ length: 400 }, (_, n) => asked(`Question ${n} ${'x'.repeat(2000)}`));
    writeLog('a', [said('Too far back to be read'), ...tail]);

    expect(sessionPreviews(['a'])).toEqual({});
  });

  it('ignores the half line the window starts in the middle of', () => {
    // A line long enough that the window cuts it, leaving a fragment that will not parse.
    const cut = said(`Cut in half ${'x'.repeat(100_000)}`);
    writeLog('a', [cut, said('After the cut')]);

    expect(sessionPreviews(['a'])).toEqual({ a: 'After the cut' });
  });

  it('reads a log smaller than the window without running off its front', () => {
    writeLog('a', [said('Short')]);

    expect(sessionPreviews(['a'])).toEqual({ a: 'Short' });
  });
});

describe('not reading the same log twice', () => {
  it('gives the same answer again for a log that has not moved', () => {
    const path = writeLog('a', [said('Unchanged')]);
    // Pinned to a whole second first: a filesystem timestamp carries more precision than a
    // Date does, so only a time it can hold exactly can be put back exactly.
    const when = new Date(1_760_000_000_000);
    utimesSync(path, when, when);
    expect(sessionPreviews(['a'])).toEqual({ a: 'Unchanged' });

    // Rewritten behind its own back, keeping size and time: only a re-read would see this.
    writeFileSync(path, said('Unchangez'));
    utimesSync(path, when, when);
    expect(statSync(path).mtimeMs).toBe(when.getTime());

    expect(sessionPreviews(['a'])).toEqual({ a: 'Unchanged' });
  });

  it('reads it again once it has grown', () => {
    const path = writeLog('a', [said('First')]);
    expect(sessionPreviews(['a'])).toEqual({ a: 'First' });

    writeFileSync(path, [said('First'), said('Second')].join('\n'));

    expect(sessionPreviews(['a'])).toEqual({ a: 'Second' });
  });

  it('reads it again when it changed without changing size', () => {
    const path = writeLog('a', [said('Before')]);
    expect(sessionPreviews(['a'])).toEqual({ a: 'Before' });

    writeFileSync(path, said('Behind'));
    const now = new Date(Date.now() + 10_000);
    utimesSync(path, now, now);

    expect(sessionPreviews(['a'])).toEqual({ a: 'Behind' });
  });

  it('remembers that a log had nothing to say, and still says nothing', () => {
    writeLog('a', [asked('Nothing answered yet')]);

    expect(sessionPreviews(['a'])).toEqual({});
    expect(sessionPreviews(['a'])).toEqual({});
  });
});

describe('what it hands back', () => {
  /**
   * Long enough to fill five lines of a sidebar dragged wide. The old limit of 160 is about
   * three lines, which is what a reader asking for five used to be given.
   */
  it('hands over enough to fill the most lines a row will draw', () => {
    writeLog('a', [said('A sentence that runs on. '.repeat(40))]);

    const preview = sessionPreviews(['a']).a!;
    expect(preview.length).toBe(500);
  });

  it('shortens one longer than that rather than handing over the whole thing', () => {
    writeLog('a', [said('x'.repeat(5000))]);

    expect(sessionPreviews(['a']).a!.endsWith('…')).toBe(true);
  });

  it('leaves a short answer whole', () => {
    writeLog('a', [said('Short enough')]);

    expect(sessionPreviews(['a'])).toEqual({ a: 'Short enough' });
  });

  it('leaves out an answer that was only formatting', () => {
    writeLog('a', [said('```\n\n```')]);

    expect(sessionPreviews(['a'])).toEqual({});
  });

  it('keeps looking past a message whose content is not text', () => {
    writeLog('a', [said('Said in words'), JSON.stringify({ type: 'assistant.message', data: { content: { parts: [] } } })]);

    expect(sessionPreviews(['a'])).toEqual({ a: 'Said in words' });
  });

  it('keeps looking past a line that is not JSON at all', () => {
    writeLog('a', [said('Said in words'), '{"type":"assistant.message","data":{"conte']);

    expect(sessionPreviews(['a'])).toEqual({ a: 'Said in words' });
  });
});
