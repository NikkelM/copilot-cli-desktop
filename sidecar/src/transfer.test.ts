import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import { createWriteStream } from 'node:fs';
import { crc32 } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

let home: string;

vi.mock('./paths.js', () => ({
  get copilotHome() {
    return home;
  },
  sessionStateDir: (sessionId: string) => join(home, 'session-state', sessionId),
}));

const { bundleName, exportSession, exportSize, importSession } = await import('./transfer.js');

const ID = '8beb9705-abe6-480e-bd77-35b90a429b2b';
const OTHER = 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8';

/** A session on disk, as the CLI leaves one. */
function session(id: string, files: Record<string, string> = {}): string {
  const dir = join(home, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), '{"type":"user.message"}\n');
  writeFileSync(join(dir, 'workspace.yaml'), `id: ${id}\nname: Brought along\n`);
  for (const [path, body] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

/** A zip built by hand, for the bundles a real export would never produce. */
async function zipOf(entries: Record<string, string>, to: string): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const [name, body] of Object.entries(entries)) zip.addBuffer(Buffer.from(body), name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(to));
  return to;
}

/**
 * A zip written byte by byte, holding one stored file under whatever name it is given.
 *
 * Needed because yazl will not produce the thing being defended against: it normalises
 * separators and refuses `..` and absolute paths outright. A guard against a hostile
 * archive cannot be tested with an archive writer that refuses to be hostile, so this
 * writes the three records a reader needs - local header, central directory, end record -
 * around a single uncompressed file.
 */
function hostileZip(name: string, body: string, to: string): string {
  const file = Buffer.from(name, 'utf8');
  const data = Buffer.from(body, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // stored, so the bytes follow as they are
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  central.writeUInt32LE(0, 42); // the local header is the first thing in the file

  const centralAt = local.length + file.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(centralAt, 16);

  writeFileSync(to, Buffer.concat([local, file, data, central, file, end]));
  return to;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'transfer-'));
  mkdirSync(join(home, 'session-state'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Moving a session between machines (#63).
 *
 * A session is a directory, so a bundle is that directory and the id it sits under - which
 * is how the id travels, since there is nowhere else in an archive to write it down.
 */
describe('writing a session out', () => {
  it('writes a file that holds something', async () => {
    session(ID);
    const to = join(home, 'out.zip');

    const { bytes } = await exportSession(ID, to);

    expect(existsSync(to)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });

  it('refuses a session that is not on this machine', async () => {
    await expect(exportSession(ID, join(home, 'out.zip'))).rejects.toThrow('not on this machine');
  });

  it('says how much there is to pack', () => {
    session(ID, { 'checkpoints/one.md': 'x'.repeat(100) });

    expect(exportSize(ID).files).toBe(3);
    expect(exportSize(ID).bytes).toBeGreaterThan(100);
  });

  it('says nothing about a session that is not there', () => {
    expect(exportSize(ID)).toEqual({ files: 0, bytes: 0 });
  });

  it('reports progress as it goes', async () => {
    session(ID, { 'files/big.txt': 'x'.repeat(50_000) });
    const seen: number[] = [];

    await exportSession(ID, join(home, 'out.zip'), (done) => seen.push(done));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThan(0);
  });

  /** A log is JSON, and a session is almost entirely its log. */
  it('compresses, rather than merely gathering', async () => {
    const dir = session(ID);
    writeFileSync(join(dir, 'events.jsonl'), `${'{"type":"user.message"}'.repeat(5000)}\n`);
    const to = join(home, 'out.zip');

    const { bytes } = await exportSession(ID, to);

    expect(bytes).toBeLessThan(exportSize(ID).bytes / 4);
  });

  /** A marker says a process on this machine has it open, which means nothing elsewhere. */
  it('leaves the open-session markers behind', async () => {
    const dir = session(ID);
    writeFileSync(join(dir, 'inuse.1234.hold'), '');
    writeFileSync(join(dir, 'inuse.1234.lock'), '1234');

    await exportSession(ID, join(home, 'out.zip'));
    rmSync(dir, { recursive: true, force: true });
    await importSession(join(home, 'out.zip'));

    expect(existsSync(join(dir, 'inuse.1234.hold'))).toBe(false);
    expect(existsSync(join(dir, 'inuse.1234.lock'))).toBe(false);
  });

  it('names the file after the session, so a folder of them can be told apart', () => {
    expect(bundleName(ID, 'Hades biomes')).toBe('Hades-biomes-8beb9705.copilot-session.zip');
  });

  it('still names a file for a session that was never named', () => {
    expect(bundleName(ID, null)).toBe('session-8beb9705.copilot-session.zip');
  });
});

describe('taking a session back in', () => {
  const roundTrip = async (files: Record<string, string> = {}) => {
    const dir = session(ID, files);
    const to = join(home, 'out.zip');
    await exportSession(ID, to);
    rmSync(dir, { recursive: true, force: true });
    return { to, dir };
  };

  it('puts the session back where it came from', async () => {
    const { to, dir } = await roundTrip();

    const { sessionId } = await importSession(to);

    expect(sessionId).toBe(ID);
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
  });

  it('brings the conversation back byte for byte', async () => {
    const { to, dir } = await roundTrip();

    await importSession(to);

    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toBe('{"type":"user.message"}\n');
  });

  it('brings what was in its folders too', async () => {
    const { to, dir } = await roundTrip({ 'checkpoints/one.md': '# first', 'files/a/b.txt': 'deep' });

    await importSession(to);

    expect(readFileSync(join(dir, 'checkpoints', 'one.md'), 'utf8')).toBe('# first');
    expect(readFileSync(join(dir, 'files', 'a', 'b.txt'), 'utf8')).toBe('deep');
  });

  it('says how much it took in', async () => {
    const { to } = await roundTrip({ 'checkpoints/one.md': '# first' });

    expect((await importSession(to)).files).toBe(3);
  });

  it('reports progress as it goes', async () => {
    const { to } = await roundTrip({ 'files/big.txt': 'x'.repeat(50_000) });
    const seen: number[] = [];

    await importSession(to, (done) => seen.push(done));

    expect(seen.length).toBeGreaterThan(0);
  });

  /** Merging two conversations that share an id would corrupt both, with no way to choose. */
  it('refuses to land on a session that is already here', async () => {
    const { to } = await roundTrip();
    await importSession(to);

    await expect(importSession(to)).rejects.toThrow('already here');
  });

  it('leaves the session that is already here untouched', async () => {
    const { to, dir } = await roundTrip();
    await importSession(to);
    writeFileSync(join(dir, 'events.jsonl'), 'mine\n');

    await importSession(to).catch(() => undefined);

    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toBe('mine\n');
  });

  it('refuses a file that is not an archive at all', async () => {
    const path = join(home, 'notazip.zip');
    writeFileSync(path, 'just some text');

    await expect(importSession(path)).rejects.toThrow('not a session bundle');
  });

  it('refuses a bundle holding more than one session', async () => {
    const path = await zipOf({ [`${ID}/events.jsonl`]: 'a', [`${OTHER}/events.jsonl`]: 'b' }, join(home, 'two.zip'));

    await expect(importSession(path)).rejects.toThrow('exactly one session');
  });

  it('refuses a bundle whose folder is not a session id', async () => {
    const path = await zipOf({ 'my-stuff/events.jsonl': 'a' }, join(home, 'odd.zip'));

    await expect(importSession(path)).rejects.toThrow('exactly one session');
  });

  // A session with no conversation would be listed and then fail the moment it was opened.
  it('refuses a bundle with no conversation in it', async () => {
    const path = await zipOf({ [`${ID}/workspace.yaml`]: 'id: x' }, join(home, 'bare.zip'));

    await expect(importSession(path)).rejects.toThrow('no conversation');
  });

  it('leaves nothing behind when it refuses one', async () => {
    const path = await zipOf({ [`${ID}/workspace.yaml`]: 'id: x' }, join(home, 'bare.zip'));

    await importSession(path).catch(() => undefined);

    expect(existsSync(join(home, 'session-state', ID))).toBe(false);
    expect(existsSync(join(home, 'session-state', `.importing-${ID}`))).toBe(false);
  });

  /**
   * A zip can name `../../somewhere`. Refused before anything is written - by yauzl, which
   * will not hand over an entry naming a path outside the archive. Asserted as behaviour
   * rather than by message, since the refusal is not this module's to word.
   */
  it('refuses a bundle that names a file outside itself', async () => {
    const path = hostileZip(`${ID}/../../escaped.txt`, 'gotcha', join(home, 'evil.zip'));

    await expect(importSession(path)).rejects.toThrow();
  });

  /** The same attack spelled the way Windows would. */
  it('refuses one that names it with backslashes', async () => {
    const path = hostileZip(`${ID}\\..\\..\\escaped.txt`, 'gotcha', join(home, 'evil2.zip'));

    await expect(importSession(path)).rejects.toThrow();
  });

  it('refuses one naming an absolute path', async () => {
    const path = hostileZip('/escaped.txt', 'gotcha', join(home, 'evil3.zip'));

    await expect(importSession(path)).rejects.toThrow();
  });

  it('writes nothing at all for a bundle that tries to escape', async () => {
    const path = hostileZip(`${ID}/../../escaped.txt`, 'gotcha', join(home, 'evil.zip'));

    await importSession(path).catch(() => undefined);

    expect(existsSync(join(home, 'escaped.txt'))).toBe(false);
    expect(existsSync(join(home, 'session-state', ID))).toBe(false);
  });
});
