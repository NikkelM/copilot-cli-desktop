import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let home: string;

async function load() {
  vi.resetModules();
  return import('./cliSettings.js');
}

/** A runtime binary, as far as this cares: bytes with schema entries somewhere inside. */
function makeRuntime(version: string, entries: unknown[], platform = 'win32-x64') {
  const dir = join(root, 'copilot', 'pkg', platform, version, 'prebuilds', platform);
  mkdirSync(dir, { recursive: true });
  // Padded with bytes that are not JSON, which is what the real one is mostly made of.
  const filler = Buffer.alloc(512, 0x7f).toString('latin1');
  writeFileSync(join(dir, 'runtime.node'), filler + entries.map((e) => JSON.stringify(e)).join(filler) + filler, 'latin1');
}

const setting = (path: string, leafKind: string, over: Record<string, unknown> = {}) => ({
  path,
  leafKind,
  description: `About ${path}`,
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-settings-'));
  home = join(root, 'copilot-home');
  mkdirSync(home, { recursive: true });
  process.env.COPILOT_HOME = home;
  process.env.LOCALAPPDATA = root;
});

afterEach(() => {
  delete process.env.COPILOT_HOME;
  delete process.env.LOCALAPPDATA;
  rmSync(root, { recursive: true, force: true });
});

describe('finding the runtime', () => {
  it('says nothing rather than failing when the CLI is laid out differently', async () => {
    delete process.env.LOCALAPPDATA;
    const { runtimeBinary, cliSettingsSchema } = await load();

    expect(runtimeBinary()).toBeNull();
    // A window without this group beats an error about a file nobody has heard of.
    expect(cliSettingsSchema()).toEqual([]);
  });

  it('takes the newest version it finds', async () => {
    makeRuntime('1.0.86', [setting('older', 'boolean')]);
    makeRuntime('1.0.87', [setting('newer', 'boolean')]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['newer']);
  });

  /** 87 is above 9; "1.0.87" is not above "1.0.9". */
  it('compares versions as numbers rather than as words', async () => {
    makeRuntime('1.0.9', [setting('lower', 'boolean')]);
    makeRuntime('1.0.87', [setting('higher', 'boolean')]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['higher']);
  });

  /** A suffix is a build leading up to the release, so the release is the newer of the two. */
  it('prefers a release to the builds that led to it', async () => {
    makeRuntime('1.0.87-0', [setting('prerelease', 'boolean')]);
    makeRuntime('1.0.87', [setting('release', 'boolean')]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['release']);
  });

  it('orders the builds among themselves', async () => {
    const { newestFirst } = await load();

    expect(['1.0.87-0', '1.0.87-3', '1.0.87-1'].sort(newestFirst)).toEqual(['1.0.87-3', '1.0.87-1', '1.0.87-0']);
  });
});

describe('reading the schema', () => {
  it('reads what the CLI says about each setting', async () => {
    makeRuntime('1.0.87', [setting('autoUpdate', 'boolean', { description: 'Update the CLI.' })]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema()).toEqual([
      { path: 'autoUpdate', kind: 'boolean', description: 'Update the CLI.' },
    ]);
  });

  it('carries what an enum may be', async () => {
    makeRuntime('1.0.87', [setting('logLevel', 'enum', { options: ['all', 'none'] })]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema()[0]?.options).toEqual(['all', 'none']);
  });

  /** There is no control for a hook definition or a list of agent names. */
  it('offers only the kinds it can draw', async () => {
    makeRuntime('1.0.87', [
      setting('aTick', 'boolean'),
      setting('aPick', 'enum', { options: ['x'] }),
      setting('aNumber', 'number'),
      setting('someText', 'string'),
      setting('aList', 'string-array'),
      setting('anObject', 'json'),
      setting('aMap', 'record-of-boolean'),
    ]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['aNumber', 'aPick', 'aTick', 'someText']);
  });

  it('reads each setting once, however often the binary repeats it', async () => {
    makeRuntime('1.0.87', [setting('autoUpdate', 'boolean'), setting('autoUpdate', 'boolean')]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema()).toHaveLength(1);
  });

  it('carries on past something that looks like an entry but is not one', async () => {
    makeRuntime('1.0.87', [setting('real', 'boolean')]);
    // A run of bytes shaped like an entry and not parseable as one, which is what a binary
    // full of unrelated strings will eventually hold.
    const file = join(root, 'copilot', 'pkg', 'win32-x64', '1.0.87', 'prebuilds', 'win32-x64', 'runtime.node');
    writeFileSync(file, `{"path":"broken","leafKind":"boolean",}${readFileSync(file, 'latin1')}`, 'latin1');
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['real']);
  });

  // 90MB to read, and nothing worth reading twice.
  it('reads the binary once', async () => {
    makeRuntime('1.0.87', [setting('autoUpdate', 'boolean')]);
    const { cliSettingsSchema } = await load();
    const first = cliSettingsSchema();

    expect(cliSettingsSchema()).toBe(first);
  });
});

/**
 * A setting that could only ever draw a terminal is one this window would be offering a
 * control over nothing. Refused by name rather than by showing only what is known good, so
 * a setting the CLI adds tomorrow appears without this app being touched.
 */
describe('what it refuses', () => {
  it('leaves out the ones that only mean something in a terminal', async () => {
    makeRuntime('1.0.87', [
      setting('mouse', 'boolean'),
      setting('scrollbar', 'boolean'),
      setting('theme', 'enum', { options: ['dim'] }),
      setting('memory', 'boolean'),
    ]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['memory']);
  });

  it('leaves out whole groups of terminal chrome', async () => {
    makeRuntime('1.0.87', [
      setting('footer.showQuota', 'boolean'),
      setting('sidebar.enabled', 'boolean'),
      setting('tabs.enabled', 'boolean'),
      setting('statusLine.padding', 'number'),
      setting('voice.enabled', 'boolean'),
      setting('sandbox.enabled', 'boolean'),
    ]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['sandbox.enabled']);
  });

  /**
   * Both say "new interactive sessions" in the schema, and both were measured doing nothing
   * to a session this app made: allow-all left it on manual, which is #199 again.
   */
  it('leaves out the ones that only reach sessions the terminal starts', async () => {
    makeRuntime('1.0.87', [
      setting('defaultMode', 'enum', { options: ['plan'] }),
      setting('defaultPermissionMode', 'enum', { options: ['allow-all'] }),
      setting('model', 'string'),
    ]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['model']);
  });

  /** New settings appear by themselves, which is the whole point of refusing by name. */
  it('keeps one it has never heard of', async () => {
    makeRuntime('1.0.87', [setting('somethingAddedLater', 'boolean')]);
    const { cliSettingsSchema } = await load();

    expect(cliSettingsSchema().map((s) => s.path)).toEqual(['somethingAddedLater']);
  });
});

describe('reading what is set', () => {
  it('reads the CLI file', async () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoUpdate: true }), 'utf8');
    const { readCliSettings } = await load();

    expect(readCliSettings()).toEqual({ autoUpdate: true });
  });

  /** A fresh install has no file, and the CLI falls back to its own defaults. */
  it('reads nothing set when there is no file', async () => {
    const { readCliSettings } = await load();

    expect(readCliSettings()).toEqual({});
  });

  it('reads nothing set rather than failing on a file it cannot parse', async () => {
    writeFileSync(join(home, 'settings.json'), 'not json', 'utf8');
    const { readCliSettings } = await load();

    expect(readCliSettings()).toEqual({});
  });

  it('reads nothing set when the file holds something other than an object', async () => {
    writeFileSync(join(home, 'settings.json'), '[1, 2, 3]', 'utf8');
    const { readCliSettings } = await load();

    expect(readCliSettings()).toEqual({});
  });
});

describe('writing', () => {
  const written = () => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));

  it('writes a setting', async () => {
    const { writeCliSettings } = await load();

    writeCliSettings({ autoUpdate: true });

    expect(written()).toEqual({ autoUpdate: true });
  });

  /**
   * The file is the CLI's and holds things this app never shows - enabled plugins, MCP
   * servers - so writing only what this window knows about would throw them away.
   */
  it('leaves the rest of the CLI file alone', async () => {
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'a@b': true }, autoUpdate: false }),
      'utf8',
    );
    const { writeCliSettings } = await load();

    writeCliSettings({ autoUpdate: true });

    expect(written()).toEqual({ enabledPlugins: { 'a@b': true }, autoUpdate: true });
  });

  /** There is no value meaning "whatever you would have done", so going back is removal. */
  it('takes a key out rather than writing nothing into it', async () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'gpt-5.5', autoUpdate: true }), 'utf8');
    const { writeCliSettings } = await load();

    writeCliSettings({ model: undefined });

    expect(written()).toEqual({ autoUpdate: true });
  });

  it('makes the file when the CLI has never written one', async () => {
    const { writeCliSettings } = await load();

    writeCliSettings({ autoUpdate: true });

    expect(written()).toEqual({ autoUpdate: true });
  });

  /**
   * Refusing beats repairing. The runtime takes the same position - it declines to update a
   * settings file it cannot parse - and overwriting one would lose whatever it held.
   */
  it('refuses a file it cannot read rather than replacing it', async () => {
    writeFileSync(join(home, 'settings.json'), '{ broken', 'utf8');
    const { writeCliSettings } = await load();

    expect(() => writeCliSettings({ autoUpdate: true })).toThrow();
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{ broken');
  });

  it('refuses a file that holds something other than an object', async () => {
    writeFileSync(join(home, 'settings.json'), '[1, 2]', 'utf8');
    const { writeCliSettings } = await load();

    expect(() => writeCliSettings({ autoUpdate: true })).toThrow(/does not hold an object/);
  });

  // The shape the CLI writes, so a file this app touched is not a wholesale rewrite in a diff.
  it('writes it the way the CLI does', async () => {
    const { writeCliSettings } = await load();

    writeCliSettings({ autoUpdate: true });

    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{\n  "autoUpdate": true\n}\n');
  });
});
