import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
let project: string;

/** paths.ts reads COPILOT_HOME once at import, so the module cache must be cleared. */
async function load() {
  vi.resetModules();
  process.env.COPILOT_HOME = home;
  return import('./lsp.js');
}

const write = (path: string, body: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
};

const userConfig = (body: unknown) => write(join(home, 'lsp.json'), body);
const projectConfig = (body: unknown) => write(join(project, '.github', 'lsp.json'), body);

const csharp = {
  command: 'csharp-ls',
  fileExtensions: { '.cs': 'csharp' },
  initializationTimeoutMs: 180000,
};

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-lsp-'));
  home = join(root, 'copilot-home');
  project = join(root, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

/**
 * Language servers are the one part of the environment panel that is read from disk rather
 * than asked for: the SDK's only LSP method loads a configuration rather than reporting one,
 * and the configuration is a pair of files with a documented shape (#165).
 */
describe('the language servers a directory would be offered', () => {
  it('says nothing where nothing is configured', async () => {
    const { lspServers } = await load();

    expect(await lspServers(project)).toEqual([]);
  });

  it('reads one the reader configured', async () => {
    userConfig({ lspServers: { 'csharp-ls': csharp } });
    const { lspServers } = await load();

    expect(await lspServers(project)).toEqual([
      { name: 'csharp-ls', command: 'csharp-ls', extensions: ['.cs'], source: 'user', enabled: true },
    ]);
  });

  it('reads one the project configured', async () => {
    projectConfig({ lspServers: { 'tsgo': { command: 'tsgo', fileExtensions: { '.ts': 'ts' } } } });
    const { lspServers } = await load();

    expect((await lspServers(project))[0]).toMatchObject({ name: 'tsgo', source: 'project' });
  });

  /** The order the CLI resolves them in: a project says what it needs for itself. */
  it('lets the project override the reader on a server they both name', async () => {
    userConfig({ lspServers: { shared: { command: 'mine', fileExtensions: {} } } });
    projectConfig({ lspServers: { shared: { command: 'theirs', fileExtensions: {} } } });
    const { lspServers } = await load();

    const found = await lspServers(project);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ command: 'theirs', source: 'project' });
  });

  it('lists every extension a server handles', async () => {
    userConfig({
      lspServers: { many: { command: 'x', fileExtensions: { '.ts': 'ts', '.tsx': 'tsx' } } },
    });
    const { lspServers } = await load();

    expect((await lspServers(project))[0]?.extensions).toEqual(['.ts', '.tsx']);
  });

  /** A disabled server stays configured, which is the point of saying so. */
  it('reports one that is switched off rather than dropping it', async () => {
    userConfig({ lspServers: { off: { command: 'x', fileExtensions: {}, disabled: true } } });
    const { lspServers } = await load();

    expect((await lspServers(project))[0]).toMatchObject({ name: 'off', enabled: false });
  });

  it('treats anything but a stored true as still enabled', async () => {
    userConfig({ lspServers: { odd: { command: 'x', fileExtensions: {}, disabled: 'yes' } } });
    const { lspServers } = await load();

    expect((await lspServers(project))[0]?.enabled).toBe(true);
  });

  /** The config allows a shell script instead of a command, which this has no field for. */
  it('survives a server with no command at all', async () => {
    userConfig({ lspServers: { scripted: { fileExtensions: { '.sh': 'sh' } } } });
    const { lspServers } = await load();

    expect((await lspServers(project))[0]).not.toHaveProperty('command');
  });

  it('survives a server with no extensions', async () => {
    userConfig({ lspServers: { bare: { command: 'x' } } });
    const { lspServers } = await load();

    expect((await lspServers(project))[0]?.extensions).toEqual([]);
  });

  /**
   * A config this app cannot parse is not this app's to repair, and a panel without the
   * section beats an error about a file the reader may not know they have.
   */
  it('says nothing rather than failing on a file it cannot parse', async () => {
    userConfig('not json at all');
    const { lspServers } = await load();

    expect(await lspServers(project)).toEqual([]);
  });

  it('says nothing for a file that holds no servers', async () => {
    userConfig({ somethingElse: true });
    const { lspServers } = await load();

    expect(await lspServers(project)).toEqual([]);
  });

  /** Asked about no directory, there is still the reader's own file to read. */
  it('reads the reader own config outside any project', async () => {
    userConfig({ lspServers: { 'csharp-ls': csharp } });
    const { lspServers } = await load();

    expect(await lspServers()).toHaveLength(1);
  });

  it('looks in the project only when there is one', async () => {
    const { lspConfigFiles } = await load();

    expect(lspConfigFiles().map((file) => file.source)).toEqual(['user']);
    expect(lspConfigFiles('C:\\repo').map((file) => file.source)).toEqual(['user', 'project']);
  });

  it('puts them in a settled order', async () => {
    userConfig({ lspServers: { zed: { command: 'z' }, alpha: { command: 'a' } } });
    const { lspServers } = await load();

    expect((await lspServers(project)).map((lsp) => lsp.name)).toEqual(['alpha', 'zed']);
  });
});
