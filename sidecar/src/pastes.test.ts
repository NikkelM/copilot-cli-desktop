import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Writing pasted files out.
 *
 * The clipboard is the one input here that another application chose the shape of, so the
 * name it carries is treated as untrusted rather than as a filename.
 */
let home: string;

/** paths.ts reads COPILOT_HOME once at import, so the module cache must be cleared. */
async function load() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./pastes.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccd-pastes-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

const SESSION = 'session-1';
const dirOf = () => join(home, 'session-state', SESSION, 'desktop-pastes');
const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('stashing a pasted file', () => {
  it('writes the bytes and returns the path', async () => {
    const { stashPaste } = await load();

    const path = stashPaste({ sessionId: SESSION, name: 'image.png', data: b64('pixels') });

    expect(path).toBe(join(dirOf(), 'image.png'));
    expect(readFileSync(path, 'utf8')).toBe('pixels');
  });

  it('creates the directory it needs', async () => {
    const { stashPaste, pasteDir } = await load();
    expect(existsSync(pasteDir(SESSION))).toBe(false);

    stashPaste({ sessionId: SESSION, name: 'a.txt', data: b64('x') });

    expect(existsSync(pasteDir(SESSION))).toBe(true);
  });

  it('keeps a second paste of the same name rather than overwriting the first', async () => {
    const { stashPaste } = await load();

    const first = stashPaste({ sessionId: SESSION, name: 'image.png', data: b64('one') });
    const second = stashPaste({ sessionId: SESSION, name: 'image.png', data: b64('two') });
    const third = stashPaste({ sessionId: SESSION, name: 'image.png', data: b64('three') });

    expect(second).toBe(join(dirOf(), 'image-2.png'));
    expect(third).toBe(join(dirOf(), 'image-3.png'));
    expect(readFileSync(first, 'utf8')).toBe('one');
  });

  it('refuses a file past the limit', async () => {
    const { stashPaste } = await load();
    const { MAX_PASTE_BYTES } = await import('../../shared/protocol.js');
    const big = Buffer.alloc(MAX_PASTE_BYTES + 1).toString('base64');

    expect(() => stashPaste({ sessionId: SESSION, name: 'big.bin', data: big })).toThrow(/Too large/);
    expect(existsSync(join(dirOf(), 'big.bin'))).toBe(false);
  });
});

describe('the name a paste arrives with', () => {
  it('cannot climb out of the directory', async () => {
    const { stashPaste } = await load();

    const path = stashPaste({ sessionId: SESSION, name: '../../escaped.txt', data: b64('x') });

    expect(path).toBe(join(dirOf(), 'escaped.txt'));
    expect(existsSync(join(home, 'session-state', 'escaped.txt'))).toBe(false);
  });

  it('drops a directory prefix, whichever way its separators lean', async () => {
    const { stashPaste } = await load();

    expect(stashPaste({ sessionId: SESSION, name: 'C:\\Users\\me\\shot.png', data: b64('x') })).toBe(
      join(dirOf(), 'shot.png'),
    );
    expect(stashPaste({ sessionId: SESSION, name: '/tmp/other.png', data: b64('x') })).toBe(
      join(dirOf(), 'other.png'),
    );
  });

  it('reduces anything unusual to a hyphen', async () => {
    const { stashPaste } = await load();

    const path = stashPaste({ sessionId: SESSION, name: 'my report: "final".txt', data: b64('x') });

    expect(path).toBe(join(dirOf(), 'my-report-final-.txt'));
  });

  it('falls back to a name when there is nothing usable left', async () => {
    const { stashPaste } = await load();

    expect(stashPaste({ sessionId: SESSION, name: '...', data: b64('x') })).toBe(join(dirOf(), 'paste'));
    expect(stashPaste({ sessionId: SESSION, name: '', data: b64('x') })).toBe(join(dirOf(), 'paste-2'));
  });
});

describe('keeping the directory from growing', () => {
  it('drops pastes older than a week and keeps the rest', async () => {
    const { stashPaste } = await load();
    mkdirSync(dirOf(), { recursive: true });
    const old = join(dirOf(), 'last-month.png');
    const recent = join(dirOf(), 'yesterday.png');
    writeFileSync(old, 'x');
    writeFileSync(recent, 'x');
    const day = 24 * 60 * 60 * 1000;
    utimesSync(old, new Date(Date.now() - 30 * day), new Date(Date.now() - 30 * day));
    utimesSync(recent, new Date(Date.now() - day), new Date(Date.now() - day));

    stashPaste({ sessionId: SESSION, name: 'new.png', data: b64('x') });

    expect(readdirSync(dirOf()).sort()).toEqual(['new.png', 'yesterday.png']);
  });
});
