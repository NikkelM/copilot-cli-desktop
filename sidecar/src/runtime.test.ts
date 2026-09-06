import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRuntime, type RuntimeOptions } from './runtime.js';

/**
 * A stand-in for a resumed session.
 * Only the surface the runtime touches is implemented, so the rules under test are the
 * runtime's own rather than the SDK's.
 */
function makeSession(id: string) {
  const handlers: ((event: unknown) => void)[] = [];
  return {
    id,
    disconnected: false,
    aborted: false,
    on(handler: (event: unknown) => void) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    emit(event: unknown) {
      for (const handler of [...handlers]) handler(event);
    },
    send: vi.fn(async () => `msg-${id}`),
    abort: vi.fn(async function (this: { aborted: boolean }) {
      this.aborted = true;
    }),
    disconnect: vi.fn(async function (this: { disconnected: boolean }) {
      this.disconnected = true;
    }),
  };
}

type FakeSession = ReturnType<typeof makeSession>;

function makeRuntime(options: Partial<RuntimeOptions> = {}) {
  const sessions = new Map<string, FakeSession>();
  const permissionHandlers = new Map<string, (request: unknown) => unknown>();
  const elicitationHandlers = new Map<string, (context: unknown) => unknown>();

  const client = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => []),
    resumeSession: vi.fn(
      async (
        id: string,
        config: {
          onPermissionRequest: (r: unknown) => unknown;
          onUserInputRequest?: (r: unknown) => unknown;
        },
      ) => {
        const session = makeSession(id);
        sessions.set(id, session);
        permissionHandlers.set(id, config.onPermissionRequest);
        if (config.onUserInputRequest) elicitationHandlers.set(id, config.onUserInputRequest);
        return session;
      },
    ),
  };

  const runtime = new SessionRuntime({
    idleTimeoutMs: 0, // Timers would make these tests about scheduling rather than rules.
    createClient: async () => client as never,
    ...options,
  });

  return { runtime, client, sessions, permissionHandlers, elicitationHandlers };
}

describe('SessionRuntime', () => {
  it('starts nothing until the first send', async () => {
    const { runtime, client } = makeRuntime();
    expect(runtime.status().serverRunning).toBe(false);
    expect(client.start).not.toHaveBeenCalled();

    await runtime.send('a', 'hello');
    expect(runtime.status().serverRunning).toBe(true);
  });

  it('reuses one server and one session across sends', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.send('a', 'one');
    await runtime.send('a', 'two');

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('resumes a session once even when sends race', async () => {
    const { runtime, client } = makeRuntime();
    await Promise.all([runtime.send('a', 'one'), runtime.send('a', 'two')]);
    expect(client.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used session past the cap', async () => {
    const { runtime, sessions } = makeRuntime({ maxLoadedSessions: 2 });
    await runtime.send('a', 'x');
    await runtime.send('b', 'x');
    await runtime.send('c', 'x');

    expect(sessions.get('a')?.disconnected).toBe(true);
    expect(runtime.status().activeSessionIds).toEqual(['c', 'b']);
  });

  it('evicts by recency of use, not order of loading', async () => {
    const { runtime, sessions } = makeRuntime({ maxLoadedSessions: 2 });
    await runtime.send('a', 'x');
    await runtime.send('b', 'x');
    await runtime.send('a', 'again'); // `b` is now the least recently used
    await runtime.send('c', 'x');

    expect(sessions.get('b')?.disconnected).toBe(true);
    expect(sessions.get('a')?.disconnected).toBe(false);
  });

  // Disconnecting mid-turn would cut the agent off part way through its work.
  it('never evicts a session that is mid-turn', async () => {
    const { runtime, sessions } = makeRuntime({ maxLoadedSessions: 1 });
    await runtime.send('busy', 'x');
    sessions.get('busy')?.emit({ type: 'assistant.turn_start', data: {} });

    await runtime.send('other', 'x');
    expect(sessions.get('busy')?.disconnected).toBe(false);
  });

  it('allows eviction again once the turn ends', async () => {
    const { runtime, sessions } = makeRuntime({ maxLoadedSessions: 1 });
    await runtime.send('busy', 'x');
    sessions.get('busy')?.emit({ type: 'assistant.turn_start', data: {} });
    sessions.get('busy')?.emit({ type: 'session.idle', data: {} });

    await runtime.evict('busy');
    expect(sessions.get('busy')?.disconnected).toBe(true);
  });

  it('reports a session as loaded only while it is resident', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('a', 'x');
    expect(runtime.isActive('a')).toBe(true);

    await runtime.evict('a');
    expect(runtime.isActive('a')).toBe(false);
  });
});

describe('permissions', () => {
  it('asks the user rather than deciding on their behalf', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    expect(onPermissionRequest).toHaveBeenCalledOnce();

    const requestId = onPermissionRequest.mock.calls[0]?.[1] as string;
    runtime.resolvePermission(requestId, 'approve-once');
    await expect(pending).resolves.toEqual({ kind: 'approve-once' });
  });

  it('rejects when the user denies', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    runtime.resolvePermission(onPermissionRequest.mock.calls[0]?.[1] as string, 'reject');
    await expect(pending).resolves.toEqual({ kind: 'reject' });
  });

  // Without a UI listening there is genuinely nobody to ask, and saying so is more honest
  // than silently approving whatever the agent wanted to do.
  it('reports no user available when nothing can prompt', async () => {
    const { runtime, permissionHandlers } = makeRuntime();
    await runtime.send('a', 'x');
    await expect(permissionHandlers.get('a')?.({ kind: 'shell' })).resolves.toEqual({
      kind: 'user-not-available',
    });
  });

  it('stops asking once the session opts into allow-all', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');
    runtime.setApprovalPolicy('a', 'approve-all');

    await expect(permissionHandlers.get('a')?.({ kind: 'shell' })).resolves.toEqual({
      kind: 'approve-for-session',
    });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it('settles requests already waiting when allow-all is switched on', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    runtime.setApprovalPolicy('a', 'approve-all');
    await expect(pending).resolves.toEqual({ kind: 'approve-for-session' });
  });

  // The agent blocks on this promise, so every teardown path has to settle it.
  it('settles pending requests when the turn is aborted', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    await runtime.abort('a');
    await expect(pending).resolves.toEqual({ kind: 'user-not-available' });
  });

  it('settles pending requests when the session is evicted', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    await runtime.evict('a');
    await expect(pending).resolves.toEqual({ kind: 'user-not-available' });
  });

  it('settles pending requests on shutdown', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    await runtime.shutdown();
    await expect(pending).resolves.toEqual({ kind: 'user-not-available' });
  });
});


describe('questions from the agent', () => {
  const ask = (handlers: Map<string, (r: unknown) => unknown>, question = 'Which database?') =>
    handlers.get('a')?.({ question, choices: ['PostgreSQL', 'MySQL'] });

  it('registers a handler so the agent can ask at all', async () => {
    const { runtime, elicitationHandlers } = makeRuntime({ onElicitationRequest: vi.fn() });
    await runtime.send('a', 'x');
    expect(elicitationHandlers.has('a')).toBe(true);
  });

  it('passes the question and its choices to the UI', async () => {
    const onElicitationRequest = vi.fn();
    const { runtime, elicitationHandlers } = makeRuntime({ onElicitationRequest });
    await runtime.send('a', 'x');

    void ask(elicitationHandlers);

    const context = onElicitationRequest.mock.calls[0]?.[2] as {
      kind: string;
      message: string;
      choices: string[];
    };
    expect(context.kind).toBe('input');
    expect(context.message).toBe('Which database?');
    expect(context.choices).toEqual(['PostgreSQL', 'MySQL']);
  });

  // The legacy variant answers with a single string, not a set of fields.
  it('returns the answer in the shape the CLI expects', async () => {
    const onElicitationRequest = vi.fn();
    const { runtime, elicitationHandlers } = makeRuntime({ onElicitationRequest });
    await runtime.send('a', 'x');

    const answered = ask(elicitationHandlers);
    runtime.resolveElicitation(onElicitationRequest.mock.calls[0]?.[1] as string, 'accept', {
      answer: 'PostgreSQL',
    });

    await expect(answered).resolves.toEqual({ answer: 'PostgreSQL', wasFreeform: true });
  });

  it('sends an empty answer when declined, rather than a value the user never gave', async () => {
    const onElicitationRequest = vi.fn();
    const { runtime, elicitationHandlers } = makeRuntime({ onElicitationRequest });
    await runtime.send('a', 'x');

    const answered = ask(elicitationHandlers);
    runtime.resolveElicitation(onElicitationRequest.mock.calls[0]?.[1] as string, 'decline', {
      answer: 'ignored',
    });

    await expect(answered).resolves.toEqual({ answer: '', wasFreeform: true });
  });

  it('answers emptily when there is no UI to ask', async () => {
    const { runtime, elicitationHandlers } = makeRuntime();
    await runtime.send('a', 'x');

    await expect(ask(elicitationHandlers)).resolves.toEqual({ answer: '', wasFreeform: true });
  });

  // The agent blocks on this promise just as it does for permissions.
  it('settles a pending question when the turn is aborted', async () => {
    const { runtime, elicitationHandlers } = makeRuntime({ onElicitationRequest: vi.fn() });
    await runtime.send('a', 'x');

    const answered = ask(elicitationHandlers);
    await runtime.abort('a');

    await expect(answered).resolves.toEqual({ answer: '', wasFreeform: true });
  });

  it('settles a pending question when the session is evicted', async () => {
    const { runtime, elicitationHandlers } = makeRuntime({ onElicitationRequest: vi.fn() });
    await runtime.send('a', 'x');

    const answered = ask(elicitationHandlers);
    await runtime.evict('a');

    await expect(answered).resolves.toEqual({ answer: '', wasFreeform: true });
  });

});

/**
 * The snapshot is taken as a turn begins, which is the only moment "before the agent
 * touched anything" is still true. These use a real repository, because what is being
 * checked is that the runtime reaches git at the right time.
 */
describe('SessionRuntime tracking what a turn changes', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ccd-runtime-git-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const inRepo = () => ({ lookupCwd: () => repo });

  /**
   * Waits for the picture the turn just asked for, using the fact that asking what changed
   * waits for it. Sleeping instead let this suite pass against the very bug it was written
   * for, because the second snapshot had not landed yet when it was checked.
   */
  const captured = async (runtime: { changes: (id: string) => Promise<unknown> }) => {
    await runtime.changes('a');
  };

  it('reports what the agent changed once a turn has begun', async () => {
    const { runtime, sessions } = makeRuntime(inRepo());
    await runtime.send('a', 'go');

    sessions.get('a')!.emit({ type: 'assistant.turn_start' });
    await captured(runtime);

    writeFileSync(join(repo, 'tracked.txt'), 'the agent wrote this\n');

    const changed = await runtime.changes('a');
    expect(changed?.changes).toEqual([{ path: join(repo, 'tracked.txt'), status: 'modified' }]);
  });

  // The reason for snapshotting at all: a session's diff is the agent's work, not whatever
  // was already open when it started.
  it('leaves out what was already changed before the turn', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'the reader was here\n');

    const { runtime, sessions } = makeRuntime(inRepo());
    await runtime.send('a', 'go');
    sessions.get('a')!.emit({ type: 'assistant.turn_start' });

    expect((await runtime.changes('a'))?.changes).toEqual([]);
  });

  it('has nothing to report before a turn has begun', async () => {
    const { runtime } = makeRuntime(inRepo());
    await runtime.send('a', 'go');

    expect(await runtime.changes('a')).toBeNull();
  });

  // Plenty of sessions run somewhere that is not a repository, and that is not a failure.
  it('says nothing rather than failing outside a repository', async () => {
    const loose = mkdtempSync(join(tmpdir(), 'ccd-runtime-loose-'));
    const { runtime, sessions } = makeRuntime({ lookupCwd: () => loose });
    await runtime.send('a', 'go');

    sessions.get('a')!.emit({ type: 'assistant.turn_start' });

    expect(await runtime.changes('a')).toBeNull();
    rmSync(loose, { recursive: true, force: true });
  });

  /**
   * The bug this was written for. Every turn used to replace the snapshot, so turn one's
   * work was inside the picture taken for turn two and vanished: only the most recent
   * edit was ever reported, which for a session doing several things is most of the work
   * silently missing.
   */
  it('keeps reporting what an earlier turn changed after a later one starts', async () => {
    const { runtime, sessions } = makeRuntime(inRepo());
    await runtime.send('a', 'go');
    const session = sessions.get('a')!;

    session.emit({ type: 'assistant.turn_start' });
    await captured(runtime);
    writeFileSync(join(repo, 'tracked.txt'), 'changed in the first turn\n');
    session.emit({ type: 'assistant.turn_end' });

    // A second turn begins, which is where the first turn's work used to disappear.
    session.emit({ type: 'assistant.turn_start' });
    await captured(runtime);
    writeFileSync(join(repo, 'second.txt'), 'changed in the second turn\n');

    const both = await runtime.changes('a');
    expect(both?.changes.map((c) => c.path).sort()).toEqual([join(repo, 'second.txt'), join(repo, 'tracked.txt')].sort());
  });

  it('can still show one turn on its own', async () => {
    const { runtime, sessions } = makeRuntime(inRepo());
    await runtime.send('a', 'go');
    const session = sessions.get('a')!;

    session.emit({ type: 'assistant.turn_start' });
    await captured(runtime);
    writeFileSync(join(repo, 'tracked.txt'), 'first turn\n');
    session.emit({ type: 'assistant.turn_end' });

    session.emit({ type: 'assistant.turn_start' });
    await captured(runtime);
    writeFileSync(join(repo, 'second.txt'), 'second turn\n');

    const turn = await runtime.changes('a', 'turn');
    expect(turn?.changes.map((c) => c.path)).toEqual([join(repo, 'second.txt')]);
  });
});

/**
 * Auditing an agent should not depend on where it chose to work. A text file in a
 * downloads folder is no less changed for being outside a checkout, and the file tools
 * account for their own work wherever it happened.
 */
describe('SessionRuntime tracking changes outside any repository', () => {
  let loose: string;

  beforeEach(() => {
    loose = mkdtempSync(join(tmpdir(), 'ccd-runtime-loose-'));
  });

  afterEach(() => rmSync(loose, { recursive: true, force: true }));

  const editReport = (path: string) =>
    [
      `diff --git a/${path.replace(/\\/g, '/')} b/${path.replace(/\\/g, '/')}`,
      'index 0000000..0000000 100644',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n');

  // Shaped as the runtime really receives it: the payload is under data, which the code
  // under test once ignored - and this helper once agreed with it, so both were wrong
  // together and the tests passed against a feature that recorded nothing.
  const completed = (toolName: string, detailedContent: string) => ({
    type: 'tool.execution_complete',
    data: { toolName, result: { detailedContent } },
  });

  it('reports a file the agent edited with no repository in sight', async () => {
    const file = join(loose, 'notes.txt');
    const { runtime, sessions } = makeRuntime({ lookupCwd: () => loose });
    await runtime.send('a', 'go');

    sessions.get('a')!.emit({ type: 'assistant.turn_start' });
    sessions.get('a')!.emit(completed('edit', editReport(file)));

    const changed = await runtime.changes('a');
    expect(changed?.changes).toEqual([{ path: file, status: 'modified' }]);
    expect(changed?.root).toBeNull();
  });

  it('gives back the patch for such a file', async () => {
    const file = join(loose, 'notes.txt');
    const { runtime, sessions } = makeRuntime({ lookupCwd: () => loose });
    await runtime.send('a', 'go');

    sessions.get('a')!.emit({ type: 'assistant.turn_start' });
    sessions.get('a')!.emit(completed('edit', editReport(file)));

    expect(await runtime.diff('a', file)).toContain('+after');
  });

  // A shell command says nothing about what it wrote, and outside a repository there is
  // no tree to compare either, so this is the honest limit of what can be known.
  it('has nothing to say about a shell command outside a repository', async () => {
    const { runtime, sessions } = makeRuntime({ lookupCwd: () => loose });
    await runtime.send('a', 'go');

    sessions.get('a')!.emit({ type: 'assistant.turn_start' });
    sessions.get('a')!.emit(completed('powershell', 'C:\\somewhere\\out.txt\n<shellId: 0 completed>'));

    expect(await runtime.changes('a')).toBeNull();
  });
});
