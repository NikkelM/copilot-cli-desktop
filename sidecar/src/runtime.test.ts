import { describe, expect, it, vi } from 'vitest';

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
    send: vi.fn(async (_options: { prompt: string; mode?: string }) => `msg-${id}`),
    rpc: { history: { listRewindPoints: vi.fn(async () => ({ points: [] })) } },
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

  /**
   * How many sessions are worth keeping resident is the reader's judgement, not this app's.
   * The idle timer already reclaims what is not being used, so a hard cap only got in the
   * way of someone deliberately working across several sessions at once.
   */
  it('keeps every session loaded by default, however many there are', async () => {
    const { runtime, sessions } = makeRuntime();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await runtime.send(id, 'x');

    expect([...sessions.values()].some((session) => session.disconnected)).toBe(false);
    expect(runtime.status().activeSessionIds).toHaveLength(6);
  });

  it('reports having no cap rather than a number nobody set', async () => {
    const { runtime } = makeRuntime();
    expect(runtime.status().maxLoadedSessions).toBe(0);
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

  /**
   * Blanket approval is the runtime's job, reached through `/allow-all`, which stops it
   * issuing a request at all. Verified against a live session: with it on, no permission
   * request reaches this handler and the tool simply runs. A flag here would have been a
   * second answer to the same question, forgotten on unload and invisible to the CLI.
   */
  it('leaves blanket approval to the runtime and always asks', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    void permissionHandlers.get('a')?.({ kind: 'shell' });

    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
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
 * A panel showing what a session changed has to know when the answer moves. The runtime
 * keeps that record itself now (#142), so every turn that ends is announced rather than only
 * the ones this app saw write something - it no longer watches the tools to know.
 */
describe('SessionRuntime announcing what a turn changed', () => {
  it('announces a turn ending', async () => {
    const onChangesRecorded = vi.fn();
    const { runtime, sessions } = makeRuntime({ onChangesRecorded });
    await runtime.send('a', 'make a file');

    const session = sessions.get('a')!;
    session.emit({ type: 'assistant.turn_start', data: {} });
    session.emit({ type: 'assistant.turn_end', data: {} });

    expect(onChangesRecorded).toHaveBeenCalledWith('a');
  });

  it('says nothing when no turn was running', async () => {
    const onChangesRecorded = vi.fn();
    const { runtime, sessions } = makeRuntime({ onChangesRecorded });
    await runtime.send('a', 'just talk');

    sessions.get('a')!.emit({ type: 'session.idle', data: {} });

    expect(onChangesRecorded).not.toHaveBeenCalled();
  });
});

/**
 * The runtime holds a turn's record in memory until the next turn begins, so a panel reading
 * the store straight after a turn would be a turn behind. Asking for the rewind points is
 * what makes it write, and there is nothing to ask a session nobody has opened.
 */
describe('SessionRuntime flushing what it holds', () => {
  it('asks a loaded session to write its record out', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'hello');

    await runtime.flushChanges('a');

    expect(sessions.get('a')!.rpc.history.listRewindPoints).toHaveBeenCalled();
  });

  it('starts no session for one that is not loaded', async () => {
    const { runtime, sessions, client } = makeRuntime();

    await runtime.flushChanges('never-opened');

    expect(sessions.size).toBe(0);
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('stays quiet when the runtime cannot answer', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'hello');
    sessions.get('a')!.rpc.history.listRewindPoints.mockRejectedValueOnce(new Error('session busy'));

    await expect(runtime.flushChanges('a')).resolves.toBeUndefined();
  });
});


/**
 * Typing while the agent works should not be refused, and the runtime is the only place
 * that knows a turn is running: a caller deciding for itself would be guessing from an
 * older answer.
 */
describe('SessionRuntime queueing behind a running turn', () => {
  const busy = (session: FakeSession) => session.emit({ type: 'assistant.turn_start', data: {} });
  const done = (session: FakeSession) => session.emit({ type: 'assistant.turn_end', data: {} });
  const modeOf = (session: FakeSession, call = 0) =>
    (session.send.mock.calls[call]?.[0] as { mode?: string } | undefined)?.mode;

  it('sends immediately when nothing is running', async () => {
    const { runtime, sessions } = makeRuntime();
    const result = await runtime.send('a', 'hello');

    expect(result.queued).toBe(false);
    expect(modeOf(sessions.get('a')!)).toBe('immediate');
  });

  it('queues behind a turn that is still running', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'first');
    busy(sessions.get('a')!);

    const result = await runtime.send('a', 'second');

    expect(result.queued).toBe(true);
    expect(modeOf(sessions.get('a')!, 1)).toBe('enqueue');
  });

  it('stops queueing once the turn has ended', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'first');
    busy(sessions.get('a')!);
    done(sessions.get('a')!);

    expect((await runtime.send('a', 'second')).queued).toBe(false);
  });

  // Another session being mid-turn says nothing about this one.
  it('judges each session on its own', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'x');
    await runtime.send('b', 'x');
    busy(sessions.get('a')!);

    expect((await runtime.send('b', 'y')).queued).toBe(false);
  });

  // A caller that has a reason to insist still can.
  it.each([
    ['enqueue', true],
    ['immediate', false],
  ] as const)('lets a caller ask for %s outright', async (mode, queued) => {
    const { runtime, sessions } = makeRuntime();
    const result = await runtime.send('a', 'hello', mode);

    expect(result.queued).toBe(queued);
    expect(modeOf(sessions.get('a')!)).toBe(mode);
  });

  it('hands back the id the session gave the message', async () => {
    const { runtime } = makeRuntime();
    expect((await runtime.send('a', 'hello')).messageId).toBe('msg-a');
  });
});
