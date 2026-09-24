import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsonRpcRequest, SidecarHandlers } from '../../shared/protocol.js';
import { PROTOCOL_VERSION, SIDECAR_METHODS } from '../../shared/protocol.js';
import { createHandlers, dispatch } from './dispatch.js';
import type { SessionRuntime } from './runtime.js';

vi.mock('./changes.js', () => ({
  sessionChanges: vi.fn(() => [{ path: 'a.ts' }]),
  sessionDiff: vi.fn(() => ({ path: 'a.ts', diff: '' })),
}));
vi.mock('./sessionIndex.js', () => ({
  listSessions: vi.fn(() => [{ sessionId: 'cold' }, { sessionId: 'warm' }]),
  findSessions: vi.fn(() => [{ sessionId: 'warm' }]),
  existingSessions: vi.fn((ids: string[]) => ids.slice(0, 1)),
}));
vi.mock('./eventLog.js', () => ({
  lastAgent: vi.fn(async () => ({ name: 'deep-audit', displayName: 'Deep Audit' })),
  lastModel: vi.fn(async () => null),
  readTranscript: vi.fn(() => ({ events: [] })),
}));
vi.mock('./directories.js', () => ({
  directoryCaseSensitive: false,
  directorySeparator: '\\',
  listDirectories: vi.fn(async () => ['src', 'tests']),
}));
vi.mock('./git.js', () => ({ treeStateOf: vi.fn(async () => null) }));
vi.mock('./images.js', () => ({ previewImage: vi.fn(() => null) }));
vi.mock('./pastes.js', () => ({ stashPaste: vi.fn(() => 'C:\\stashed.png') }));

const { sessionChanges, sessionDiff } = await import('./changes.js');
const { listDirectories } = await import('./directories.js');
const { listSessions } = await import('./sessionIndex.js');

const ask = (method: string, params?: unknown) =>
  ({ jsonrpc: '2.0', id: 1, method, params }) as unknown as JsonRpcRequest;

const table = (entries: Record<string, (params: unknown) => unknown>) => entries as unknown as SidecarHandlers;

describe('routing a request to its handler', () => {
  it('calls the named handler with the parameters as they arrived', async () => {
    const handler = vi.fn(() => 'answered');

    const result = await dispatch(table({ 'git.state': handler }), ask('git.state', { cwd: 'C:\\repo' }));

    expect(handler).toHaveBeenCalledWith({ cwd: 'C:\\repo' });
    expect(result).toBe('answered');
  });

  it('waits for a handler that answers later', async () => {
    const handlers = table({ 'git.state': async () => 'eventually' });

    await expect(dispatch(handlers, ask('git.state'))).resolves.toBe('eventually');
  });

  /**
   * The caller is blocked on a reply, and a result that is absent from the JSON is not the
   * same thing as one that is empty: a handler with nothing to say still has to say it.
   */
  it('answers null for a handler that returns nothing', async () => {
    const handlers = table({ 'sessions.abort': () => undefined });

    await expect(dispatch(handlers, ask('sessions.abort'))).resolves.toBeNull();
  });

  it('lets a handler\u2019s failure through, for the caller to turn into an error reply', async () => {
    const handlers = table({
      'sessions.abort': () => {
        throw new Error('no such session');
      },
    });

    await expect(dispatch(handlers, ask('sessions.abort'))).rejects.toThrow('no such session');
  });

  it('names the method it did not recognise', async () => {
    await expect(dispatch(table({}), ask('sessions.destroy'))).rejects.toThrow('Unknown method: sessions.destroy');
  });

  /**
   * The method is text off a pipe, so a plain lookup finds everything an object inherits.
   * `constructor` would be called and would answer with something that is not a result.
   */
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'treats the inherited name %s as no method at all',
    async (name) => {
      await expect(dispatch(table({}), ask(name))).rejects.toThrow(`Unknown method: ${name}`);
    },
  );
});

describe('what the sidecar answers', () => {
  const runtime = {
    status: vi.fn(() => ({ activeSessionIds: ['warm'] })),
    isActive: vi.fn((id: string) => id === 'warm'),
    flushChanges: vi.fn(async () => undefined),
  } as unknown as SessionRuntime;

  let handlers: SidecarHandlers;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = createHandlers(runtime);
  });

  /**
   * A turn's changes are written when it settles, so reading them without flushing first
   * answers with everything except the work that prompted the question.
   */
  it('flushes what the last turn changed before reading the list', async () => {
    await handlers['sessions.changes']({ sessionId: 's1' });

    expect(runtime.flushChanges).toHaveBeenCalledWith('s1');
    expect(vi.mocked(sessionChanges).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(runtime.flushChanges).mock.invocationCallOrder[0],
    );
  });

  it('flushes before reading one file\u2019s diff, for the same reason', async () => {
    await handlers['sessions.diff']({ sessionId: 's1', path: 'a.ts' });

    expect(runtime.flushChanges).toHaveBeenCalledWith('s1');
    expect(vi.mocked(sessionDiff).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(runtime.flushChanges).mock.invocationCallOrder[0],
    );
  });

  /**
   * The list is read from the database, which does not know what this app is holding, and a
   * session started moments ago is not in it yet at all.
   */
  it('marks which listed sessions are loaded, and asks for the ones only it knows about', async () => {
    const { sessions } = await handlers['sessions.list'](undefined as never);

    expect(vi.mocked(listSessions)).toHaveBeenCalledWith(['warm']);
    expect(sessions.map((s) => [s.sessionId, s.loaded])).toEqual([
      ['cold', false],
      ['warm', true],
    ]);
  });

  it('marks them the same way when they were found by id', async () => {
    const { sessions } = await handlers['sessions.find']({ prefix: 'wa' });

    expect(sessions.map((s) => s.loaded)).toEqual([true]);
  });

  /** Nothing sends parameters for a command list with no session, so none must be assumed. */
  it('asks for commands without a session when none was named', async () => {
    const commands = vi.fn(async () => []);
    const bare = createHandlers({ ...runtime, commands } as unknown as SessionRuntime);

    await bare['commands.list'](undefined as never);

    expect(commands).toHaveBeenCalledWith(undefined);
  });

  it('lists folders from disk without asking the runtime', async () => {
    const result = await handlers['filesystem.directories']({ cwd: 'C:\\repo', path: 'src\\' });

    expect(listDirectories).toHaveBeenCalledWith('C:\\repo', 'src\\');
    expect(result).toEqual({ entries: ['src', 'tests'], separator: '\\', caseSensitive: false });
  });

  /** Browsing agents outside any session sends nothing at all, for the same reason. */
  it('asks for agents without a directory when none was named', async () => {
    const agents = vi.fn(async () => []);
    const bare = createHandlers({ ...runtime, discovery: { agents } } as unknown as SessionRuntime);

    await bare['agents.list'](undefined as never);

    expect(agents).toHaveBeenCalledWith(undefined);
  });

  it('passes a working directory on, so a project\u2019s own agents are found', async () => {
    const agents = vi.fn(async () => []);
    const bare = createHandlers({ ...runtime, discovery: { agents } } as unknown as SessionRuntime);

    await bare['agents.list']({ cwd: 'C:\\repo' });

    expect(agents).toHaveBeenCalledWith('C:\\repo');
  });

  it('reads the current agent from the log rather than the session', async () => {
    const { agent } = await handlers['agents.current']({ sessionId: 'cold' });

    expect(agent).toEqual({ name: 'deep-audit', displayName: 'Deep Audit' });
  });

  it('selects an agent by name', async () => {
    const selectAgent = vi.fn(async () => undefined);
    const bare = createHandlers({ ...runtime, selectAgent } as unknown as SessionRuntime);

    await bare['agents.select']({ sessionId: 's1', name: 'deep-audit' });

    expect(selectAgent).toHaveBeenCalledWith('s1', 'deep-audit');
  });

  /** Deselecting is the same call with nothing chosen, which is what keeps the two in step. */
  it('deselects by asking for no agent at all', async () => {
    const selectAgent = vi.fn(async () => undefined);
    const bare = createHandlers({ ...runtime, selectAgent } as unknown as SessionRuntime);

    await bare['agents.deselect']({ sessionId: 's1' });

    expect(selectAgent).toHaveBeenCalledWith('s1', null);
  });
});

/**
 * The handshake is only worth anything if the version it reports describes the methods this
 * build actually answers. These are the tests that keep those two facts the same fact.
 */
describe('the contract the sidecar reports', () => {
  const runtime = {} as unknown as SessionRuntime;

  it('answers with the version compiled into it', () => {
    const handlers = createHandlers(runtime);

    expect(handlers['protocol.version']()).toEqual({ version: PROTOCOL_VERSION });
  });

  /**
   * A missing handler is already a build error, since `SidecarHandlers` requires one per
   * method. An extra is not, and would be a method the version never mentions.
   */
  it('answers exactly the methods the protocol declares, and no others', () => {
    const answered = Object.keys(createHandlers(runtime)).sort();

    expect(answered).toEqual([...SIDECAR_METHODS].sort());
  });

  /** The one handler that has to work on a sidecar too old to do anything else usefully. */
  it('reports the version without touching the runtime', () => {
    const exploded = new Proxy(
      {},
      {
        get() {
          throw new Error('the version handler must not reach the runtime');
        },
      },
    ) as SessionRuntime;

    expect(createHandlers(exploded)['protocol.version']()).toHaveProperty('version');
  });
});
