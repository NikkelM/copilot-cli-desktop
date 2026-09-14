import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { CopilotSession } from '@github/copilot-sdk';

import { copilotHome } from './paths.js';
import { SessionRuntime, type RuntimeOptions } from './runtime.js';

/** Tied to the SDK's own signature so a shape change fails the build rather than the fake. */
type ContextAttribution = Awaited<ReturnType<CopilotSession['rpc']['metadata']['getContextAttribution']>>;
/** The same, for the command result whose `mode` follow-up was being dropped (#167). */
type InvokeResult = Awaited<ReturnType<CopilotSession['rpc']['commands']['invoke']>>;

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
    rpc: {
      history: { listRewindPoints: vi.fn(async () => ({ points: [] })) },
      shell: {
        executeUserRequested: vi.fn(async (_params: { requestId: string; command: string }) => ({
          toolCallId: 'call-1',
          success: true,
          output: 'ok\u001B[0m',
          exitCode: 0,
        })),
        cancelUserRequested: vi.fn(async (_params: { requestId: string }) => ({ cancelled: true })),
      },
      queue: {
        pendingItems: vi.fn(async () => ({
          items: [
            { id: 'q1', messageId: 'm1', kind: 'message', displayText: 'do a thing\u001B[0m', agentMode: 'agent' },
            { id: 'q2', kind: 'command', displayText: '/compact', agentMode: 'agent' },
            { id: 'q3', kind: 'model-change', displayText: '/model gpt-5', agentMode: 'agent' },
          ],
          steeringMessages: [],
        })),
      },
      commands: {
        enqueue: vi.fn(async (_params: { command: string; displayText?: string }) => ({ queued: true })),
        invoke: vi.fn(async (_params: { name: string; input?: string }): Promise<InvokeResult> => ({ kind: 'completed' })),
      },
      mode: {
        get: vi.fn(async () => 'interactive' as const),
        set: vi.fn(async (_params: { mode: string }) => ({ status: 'unchanged', modelChanged: false })),
      },
      agent: {
        select: vi.fn(async (_params: { name: string }) => ({})),
        deselect: vi.fn(async () => undefined),
      },
      options: {
        update: vi.fn(async (_params: { disabledSkills?: string[] }) => ({ success: true })),
      },
      metadata: {
        getContextAttribution: vi.fn(async (): Promise<ContextAttribution> => ({
          contextAttribution: {
            totalTokens: 34_000,
            modelId: 'claude-opus-5',
            modelSource: 'selected',
            promptTokenLimit: 128_000,
            limit: 144_000,
            bufferTokens: 16_000,
            compactionThreshold: 102_400,
            categories: {
              systemPrompt: 4000,
              customInstructions: 1000,
              systemTools: 8000,
              mcpTools: 2000,
              messages: 19_000,
              freeSpace: 94_000,
              buffer: 16_000,
            },
            entries: [],
            compactions: { count: 2 },
          },
        })),
      },
    },
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
    rpc: {
      agents: {
        discover: vi.fn(async (_params: { projectPaths?: string[] }) => ({
          agents: [
            {
              id: 'deep-audit',
              name: 'deep-audit',
              displayName: 'Deep Audit',
              description: 'Audits things',
              source: 'user',
              path: 'C:\\Users\\x\\.copilot\\agents\\deep-audit.agent.md',
              tools: ['grep', 'view'],
              prompt: 'a very long prompt',
            },
            {
              id: 'spawned-only',
              name: 'spawned-only',
              displayName: 'Spawned Only',
              description: 'Not for people',
              userInvocable: false,
            },
          ],
        })),
      },
      plugins: {
        list: vi.fn(async () => ({
          plugins: [
            { name: 'context-engineering', marketplace: 'awesome-copilot', enabled: true },
            { name: 'project-planning', marketplace: 'awesome-copilot', enabled: true },
            { name: 'switched-off', marketplace: 'awesome-copilot', enabled: false },
          ],
        })),
      },
    },
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
    createSession: vi.fn(async (_config: Record<string, unknown>) => {
      const session = { ...makeSession('made'), sessionId: 'made' };
      sessions.set('made', session);
      return session;
    }),
  };

  const runtime = new SessionRuntime({
    idleTimeoutMs: 0, // Timers would make these tests about scheduling rather than rules.
    createClient: async () => client as never,
    ...options,
  });

  return { runtime, client, sessions, permissionHandlers, elicitationHandlers };
}

/**
 * Send, then let the request finish.
 *
 * A session counts as busy from the moment a message is accepted until the runtime says it
 * has gone idle, so a test about what happens between requests has to end one: a session
 * left mid-request cannot be evicted, which is the whole point of the flag.
 */
async function sendAndFinish(
  { runtime, sessions }: { runtime: SessionRuntime; sessions: Map<string, FakeSession> },
  id: string,
  prompt = 'x',
): Promise<void> {
  await runtime.send(id, prompt);
  sessions.get(id)?.emit({ type: 'session.idle', data: {} });
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
    const harness = makeRuntime({ maxLoadedSessions: 2 });
    const { runtime, sessions } = harness;
    await sendAndFinish(harness, 'a');
    await sendAndFinish(harness, 'b');
    await sendAndFinish(harness, 'c');

    expect(sessions.get('a')?.disconnected).toBe(true);
    expect(runtime.status().activeSessionIds).toEqual(['c', 'b']);
  });

  it('evicts by recency of use, not order of loading', async () => {
    const harness = makeRuntime({ maxLoadedSessions: 2 });
    const { sessions } = harness;
    await sendAndFinish(harness, 'a');
    await sendAndFinish(harness, 'b');
    await sendAndFinish(harness, 'a', 'again'); // `b` is now the least recently used
    await sendAndFinish(harness, 'c');

    expect(sessions.get('b')?.disconnected).toBe(true);
    expect(sessions.get('a')?.disconnected).toBe(false);
  });

  // Disconnecting mid-turn would cut the agent off part way through its work.
  it('never evicts a session that is mid-turn', async () => {
    const harness = makeRuntime({ maxLoadedSessions: 1 });
    const { runtime, sessions } = harness;
    await runtime.send('busy', 'x');
    sessions.get('busy')?.emit({ type: 'assistant.turn_start', data: {} });

    await runtime.send('other', 'x');
    expect(sessions.get('busy')?.disconnected).toBe(false);
  });

  /**
   * The gap between the round trips of one request is not a moment of idleness, and a
   * session evicted in it loses the work it was part way through. This is the case the
   * test above missed for as long as `busy` was cleared on `assistant.turn_end`.
   */
  it('never evicts a session between the turns of one request', async () => {
    const harness = makeRuntime({ maxLoadedSessions: 1 });
    const { runtime, sessions } = harness;
    await runtime.send('busy', 'x');
    sessions.get('busy')?.emit({ type: 'assistant.turn_start', data: {} });
    sessions.get('busy')?.emit({ type: 'assistant.turn_end', data: {} });

    await runtime.send('other', 'x');
    expect(sessions.get('busy')?.disconnected).toBe(false);
  });

  it('allows eviction again once the request has finished', async () => {
    const { runtime, sessions } = makeRuntime({ maxLoadedSessions: 1 });
    await runtime.send('busy', 'x');
    sessions.get('busy')?.emit({ type: 'assistant.turn_start', data: {} });
    sessions.get('busy')?.emit({ type: 'session.idle', data: {} });

    await runtime.send('other', 'x');
    expect(sessions.get('busy')?.disconnected).toBe(true);
  });

  // Reclaiming memory unasked is what has to wait for the work to finish. Being told to
  // release a session is somebody having decided already.
  it('releases a session mid-request when asked to directly', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('busy', 'x');
    sessions.get('busy')?.emit({ type: 'assistant.turn_start', data: {} });

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

  /**
   * Giving up on the user unblocks the agent, but the prompt is still on screen: without
   * being told, the UI goes on offering buttons whose answer has nowhere left to go.
   */
  it('tells the UI when it gives up waiting for an answer', async () => {
    const onPermissionResolved = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({
      onPermissionRequest: vi.fn(),
      onPermissionResolved,
      permissionTimeoutMs: 5,
    });
    await runtime.send('a', 'x');

    await expect(permissionHandlers.get('a')?.({ kind: 'shell' })).resolves.toEqual({
      kind: 'user-not-available',
    });
    expect(onPermissionResolved).toHaveBeenCalledWith('a', expect.stringMatching(/^perm-/));
  });

  it('tells the UI when it gives up waiting for an answer to a question', async () => {
    const onElicitationResolved = vi.fn();
    const { runtime, elicitationHandlers } = makeRuntime({
      onElicitationRequest: vi.fn(),
      onElicitationResolved,
      permissionTimeoutMs: 5,
    });
    await runtime.send('a', 'x');

    await elicitationHandlers.get('a')?.({ message: 'pick one' });
    expect(onElicitationResolved).toHaveBeenCalledWith(expect.stringMatching(/^(elicit|input)-/));
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
 * keeps that record itself now (#142) and finishes writing it when the session goes idle -
 * `assistant.turn_end` is one model round trip, and a turn that calls a tool ends and starts
 * again several times before the work is done.
 */
describe('SessionRuntime announcing what a turn changed', () => {
  it('announces a session going idle', async () => {
    const onChangesRecorded = vi.fn();
    const { runtime, sessions } = makeRuntime({ onChangesRecorded });
    await runtime.send('a', 'make a file');

    const session = sessions.get('a')!;
    session.emit({ type: 'assistant.turn_start', data: {} });
    session.emit({ type: 'session.idle', data: {} });

    expect(onChangesRecorded).toHaveBeenCalledWith('a');
  });

  it('stays quiet between the round trips of one turn', async () => {
    const onChangesRecorded = vi.fn();
    const { runtime, sessions } = makeRuntime({ onChangesRecorded });
    await runtime.send('a', 'make a file');

    const session = sessions.get('a')!;
    session.emit({ type: 'assistant.turn_start', data: {} });
    session.emit({ type: 'assistant.turn_end', data: {} });
    session.emit({ type: 'assistant.turn_start', data: {} });
    session.emit({ type: 'assistant.turn_end', data: {} });

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
  const done = (session: FakeSession) => session.emit({ type: 'session.idle', data: {} });
  const roundTrip = (session: FakeSession) => session.emit({ type: 'assistant.turn_end', data: {} });
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

  it('stops queueing once the request has finished', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'first');
    busy(sessions.get('a')!);
    done(sessions.get('a')!);

    expect((await runtime.send('a', 'second')).queued).toBe(false);
  });

  /**
   * A request that calls tools ends and starts a turn many times over. Sending immediately
   * in one of those gaps interrupts the run the message was meant to follow, which is the
   * opposite of what typing ahead is for.
   */
  it('keeps queueing between the turns of one request', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'first');
    busy(sessions.get('a')!);
    roundTrip(sessions.get('a')!);

    expect((await runtime.send('a', 'second')).queued).toBe(true);
    expect(modeOf(sessions.get('a')!, 1)).toBe('enqueue');
  });

  // Stopping the turn is the reader saying they want it to end, so the next message is not
  // typed ahead of anything.
  it('stops queueing once the turn is aborted', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'first');
    busy(sessions.get('a')!);
    await runtime.abort('a');

    expect((await runtime.send('a', 'second')).queued).toBe(false);
  });

  // A message accepted but not yet announced as a turn is still work in flight.
  it('queues behind a request whose first turn has not started', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('a', 'first');

    expect((await runtime.send('a', 'second')).queued).toBe(true);
  });

  // Another session being mid-turn says nothing about this one.
  it('judges each session on its own', async () => {
    const harness = makeRuntime();
    const { runtime, sessions } = harness;
    await runtime.send('a', 'x');
    await sendAndFinish(harness, 'b');
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

/**
 * A shell command the reader typed. It goes through the runtime rather than being run
 * beside it, so it is emitted as a tool call and its output reaches the agent's context -
 * verified against the real runtime, which answers a question about it afterwards (#134).
 */
describe('running a shell command for the reader', () => {
  it('runs it in the session, resuming one that is cold', async () => {
    const { runtime, sessions } = makeRuntime();

    const result = await runtime.shell('s1', 'req-1', 'git status');

    expect(sessions.get('s1')!.rpc.shell.executeUserRequested).toHaveBeenCalledWith({
      requestId: 'req-1',
      command: 'git status',
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  /** The session's shell is a terminal as far as the command knows; this app draws HTML. */
  it('strips the terminal escapes out of the output', async () => {
    const { runtime } = makeRuntime();
    expect((await runtime.shell('s1', 'req-1', 'ls')).output).toBe('ok');
  });

  it('cancels by the handle the caller chose', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.shell('s1', 'req-1', 'sleep 60');

    await runtime.cancelShell('s1', 'req-1');
    expect(sessions.get('s1')!.rpc.shell.cancelUserRequested).toHaveBeenCalledWith({ requestId: 'req-1' });
  });

  /** Waking a session to cancel a command that cannot be running would cost a process. */
  it('does not resume a cold session to cancel nothing', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.cancelShell('never-loaded', 'req-1');
    expect(client.resumeSession).not.toHaveBeenCalled();
  });
});

describe('reading the queue the runtime owns', () => {
  it('reports what a loaded session has waiting', async () => {
    const { runtime } = makeRuntime();
    // Loaded by sending; a session that was never woken has no queue to read.
    await runtime.send('s1', 'hello');

    const items = await runtime.queue('s1');

    expect(items.map((item) => item.id)).toEqual(['q1', 'q2', 'q3']);
    expect(items[0]).toMatchObject({ kind: 'message', messageId: 'm1' });
    expect(items[1]).toMatchObject({ kind: 'command', text: '/compact' });
  });

  /** Anything that is neither is still waiting, and dropping it would undercount the queue. */
  it('keeps an item it does not have a name for', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('s1', 'hello');

    expect((await runtime.queue('s1'))[2]).toMatchObject({ kind: 'other', text: '/model gpt-5' });
  });

  it('strips the terminal escapes out of what it will draw', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('s1', 'hello');

    expect((await runtime.queue('s1'))[0]!.text).toBe('do a thing');
  });

  /**
   * The sidebar asks about every session. Waking each one to be told it has nothing waiting
   * is exactly the cost this app exists to avoid.
   */
  it('does not resume a cold session to ask what it has waiting', async () => {
    const { runtime, client } = makeRuntime();

    expect(await runtime.queue('s1')).toEqual([]);
    expect(client.resumeSession).not.toHaveBeenCalled();
  });
});

describe('queueing a command behind a running turn', () => {
  it('enqueues it, with the text to show for it', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');

    expect(await runtime.enqueue('s1', '/compact', '/compact')).toBe(true);
    expect(sessions.get('s1')!.rpc.commands.enqueue).toHaveBeenCalledWith({
      command: '/compact',
      displayText: '/compact',
    });
  });

  // A session that does not queue locally says so, and the caller has to handle it.
  it('reports a session that will not queue', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');
    sessions.get('s1')!.rpc.commands.enqueue.mockResolvedValueOnce({ queued: false });

    expect(await runtime.enqueue('s1', '/compact')).toBe(false);
  });
});

/**
 * The usage figures are emitted live and never written to the log, so a cold session cannot
 * be asked how full it is - and must not be woken to find out, which is the cost this app
 * exists to avoid.
 */
describe('how full a session window is', () => {
  it('reports the breakdown for a loaded session', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('s1', 'hello');

    expect(await runtime.contextUsage('s1')).toEqual({
      totalTokens: 34_000,
      promptTokenLimit: 128_000,
      compactionThreshold: 102_400,
      categories: {
        systemPrompt: 4000,
        customInstructions: 1000,
        systemTools: 8000,
        mcpTools: 2000,
        messages: 19_000,
        freeSpace: 94_000,
      },
      compactions: 2,
    });
  });

  it('says nothing for a session that is not loaded', async () => {
    const { runtime, sessions } = makeRuntime();

    expect(await runtime.contextUsage('never-opened')).toBeNull();
    expect(sessions.has('never-opened')).toBe(false);
  });

  // Asking is what the sidebar does for whichever session is open, so it must never be the
  // thing that starts a Copilot process.
  it('does not resume a cold session to answer', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.contextUsage('cold');

    expect(client.start).not.toHaveBeenCalled();
  });

  // Null until the session has built its system prompt and tool metadata, which the runtime
  // reports by answering with a null attribution rather than with zeroes.
  it('says nothing when the session has not finished starting', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');
    sessions.get('s1')!.rpc.metadata.getContextAttribution.mockResolvedValueOnce({ contextAttribution: null });

    expect(await runtime.contextUsage('s1')).toBeNull();
  });

  // The property is optional as well as nullable, so an older runtime that omits it entirely
  // has to read as "no answer" rather than throw on the way past the guard.
  it('says nothing when the runtime omits the attribution', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');
    sessions.get('s1')!.rpc.metadata.getContextAttribution.mockResolvedValueOnce({});

    expect(await runtime.contextUsage('s1')).toBeNull();
  });
});

/**
 * A command that reports a mode is asking the host to apply it.
 *
 * `/plan` and `/autopilot` are runtime commands, so they reach the session and return
 * `completed` - but the switch itself is the host's to perform. Dropping it made both
 * commands run, report success and change nothing, which is indistinguishable from a
 * command this app does not support except that it does not say so (#167).
 */
describe('a command that changes the mode', () => {
  it('applies the mode the command asked for', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    const session = sessions.get('s1')!;
    session.rpc.commands.invoke.mockResolvedValueOnce({ kind: 'completed', mode: 'plan' });

    await runtime.invoke('s1', 'plan');

    expect(session.rpc.mode.set).toHaveBeenCalledWith({ mode: 'plan' });
  });

  it('reports the mode back, so the switch is not silent', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    sessions.get('s1')!.rpc.commands.invoke.mockResolvedValueOnce({ kind: 'completed', mode: 'autopilot' });

    expect(await runtime.invoke('s1', 'autopilot')).toEqual({ kind: 'done', mode: 'autopilot' });
  });

  // Most commands complete without touching the mode, and switching to a default would put
  // every one of them through a mode change the reader never asked for.
  it('leaves the mode alone when the command says nothing about it', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    const session = sessions.get('s1')!;
    session.rpc.commands.invoke.mockResolvedValueOnce({ kind: 'completed', message: 'done' });

    expect(await runtime.invoke('s1', 'compact')).toEqual({ kind: 'done', message: 'done' });
    expect(session.rpc.mode.set).not.toHaveBeenCalled();
  });
});

/**
 * A running tool resends its whole output on every chunk, so an unbounded forward is
 * quadratic in the pipe. The transcript keeps 4000 characters of it either way.
 */
describe('output from a tool that is still running', () => {
  it('forwards a short chunk untouched', async () => {
    const seen: { type: string; data: { partialOutput: string } }[] = [];
    const { runtime, sessions } = makeRuntime({
      onEvent: (_id, event) => seen.push(event as never),
    });

    await runtime.send('s1', 'x');
    sessions.get('s1')!.emit({ type: 'tool.execution_partial_result', data: { toolCallId: 't1', partialOutput: 'line 1' } });

    expect(seen.at(-1)!.data.partialOutput).toBe('line 1');
  });

  it('cuts a chunk far longer than anything that will be shown', async () => {
    const seen: { type: string; data: { partialOutput: string } }[] = [];
    const { runtime, sessions } = makeRuntime({
      onEvent: (_id, event) => seen.push(event as never),
    });

    await runtime.send('s1', 'x');
    sessions
      .get('s1')!
      .emit({ type: 'tool.execution_partial_result', data: { toolCallId: 't1', partialOutput: 'x'.repeat(200_000) } });

    const forwarded = seen.at(-1)!.data.partialOutput;
    expect(forwarded.length).toBe(16_000);
    // Cut from the start, matching what a finished tool's output shows.
    expect(forwarded.startsWith('xxx')).toBe(true);
  });

  it('leaves the toolCallId alone so the row can still be found', async () => {
    const seen: { data: { toolCallId: string } }[] = [];
    const { runtime, sessions } = makeRuntime({
      onEvent: (_id, event) => seen.push(event as never),
    });

    await runtime.send('s1', 'x');
    sessions
      .get('s1')!
      .emit({ type: 'tool.execution_partial_result', data: { toolCallId: 't1', partialOutput: 'y'.repeat(20_000) } });

    expect(seen.at(-1)!.data.toolCallId).toBe('t1');
  });
});

describe('custom agents', () => {
  /**
   * The reason this goes through the server rather than a session at all. Listing agents is
   * browsing, and browsing must not start a conversation to answer a question about one.
   */
  it('lists agents without resuming any session', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.agents();

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('asks about a project when given a directory, so its own agents are found', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.agents('C:\\repo');

    expect(client.rpc.agents.discover).toHaveBeenCalledWith({ projectPaths: ['C:\\repo'] });
  });

  /** A session that is not about a project has no project path, which is not an empty one. */
  it('asks about no project when given no directory', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.agents();

    expect(client.rpc.agents.discover).toHaveBeenCalledWith({});
  });

  it('keeps what a picker needs and drops what it does not', async () => {
    const { runtime } = makeRuntime();

    const [first] = await runtime.agents();

    expect(first).toEqual({
      id: 'deep-audit',
      name: 'deep-audit',
      displayName: 'Deep Audit',
      description: 'Audits things',
      source: 'user',
      path: 'C:\\Users\\x\\.copilot\\agents\\deep-audit.agent.md',
      userInvocable: true,
    });
  });

  /** Absent means invocable: the field is there to mark the exceptions, not the rule. */
  it('treats an agent that does not say as one the reader may choose', async () => {
    const { runtime } = makeRuntime();

    const agents = await runtime.agents();

    expect(agents.map((agent) => agent.userInvocable)).toEqual([true, false]);
  });

  it('selects an agent on the session it names', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');

    await runtime.selectAgent('s1', 'deep-audit');

    expect(sessions.get('s1')!.rpc.agent.select).toHaveBeenCalledWith({ name: 'deep-audit' });
    expect(sessions.get('s1')!.rpc.agent.deselect).not.toHaveBeenCalled();
  });

  it('returns a session to the default agent when given no name', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');

    await runtime.selectAgent('s1', null);

    expect(sessions.get('s1')!.rpc.agent.deselect).toHaveBeenCalled();
    expect(sessions.get('s1')!.rpc.agent.select).not.toHaveBeenCalled();
  });

  /**
   * Choosing is an act on a conversation rather than a question about one, so it resumes,
   * the same way setting a model does.
   */
  it('resumes a cold session to select on it', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.selectAgent('cold', 'deep-audit');

    expect(client.resumeSession).toHaveBeenCalledTimes(1);
  });
});

/**
 * The reader's own configuration reaches the session.
 *
 * Off by default in the SDK, which left every session here without the agents, skills and
 * instructions the same session had in a terminal (#161). The failure is silent - a session
 * just behaves slightly differently - so nothing but a test would notice it coming back off.
 */
describe('config discovery', () => {
  it('lets a new session find what the reader has configured', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.create('C:\\repo');

    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ enableConfigDiscovery: true }));
  });

  it('lets a resumed session find it too', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.send('s1', 'x');

    expect(client.resumeSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ enableConfigDiscovery: true }),
    );
  });
});

/**
 * MCP logins outlive the session that made them.
 *
 * The SDK discards them by default, which is the wrong default for an app that evicts and
 * revives sessions under a cap: the reader would re-authenticate for reasons they never see
 * and cannot predict. Silent until an OAuth-backed server is configured, so only a test
 * notices it reverting (#162).
 */
describe('MCP OAuth tokens', () => {
  it('keeps the logins a new session makes', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.create('C:\\repo');

    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ mcpOAuthTokenStorage: 'persistent' }),
    );
  });

  it('keeps them across the resume that would have dropped them', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.send('s1', 'x');

    expect(client.resumeSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ mcpOAuthTokenStorage: 'persistent' }),
    );
  });
});

describe('plugin skills', () => {
  const dir = (name: string) => join(copilotHome, 'installed-plugins', 'awesome-copilot', name);

  it('points a new session at every installed plugin', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.create('C:\\repo');

    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginDirectories: [dir('context-engineering'), dir('project-planning')],
      }),
    );
  });

  it('points a resumed session at them too', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.send('s1', 'x');

    expect(client.resumeSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        pluginDirectories: [dir('context-engineering'), dir('project-planning')],
      }),
    );
  });

  it('leaves out a plugin the reader has disabled', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.create('C:\\repo');

    const config = client.createSession.mock.calls[0][0] as { pluginDirectories: string[] };
    expect(config.pluginDirectories).not.toContain(dir('switched-off'));
  });

  it('asks the runtime once however many sessions open', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.create('C:\\repo');
    await runtime.create('C:\\other');
    await runtime.send('s1', 'x');

    expect(client.rpc.plugins.list).toHaveBeenCalledTimes(1);
  });

  it('still opens a session when the plugin list cannot be read', async () => {
    const { runtime, client } = makeRuntime();
    client.rpc.plugins.list.mockRejectedValueOnce(new Error('no plugins for you'));

    await expect(runtime.create('C:\\repo')).resolves.toMatchObject({ sessionId: expect.any(String) });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ pluginDirectories: [] }));
  });
});

/**
 * The runtime's own per-session skill disable is forgotten on the next resume - measured by
 * disabling, disconnecting, resuming and finding the skill back on. This app resumes
 * constantly, so the choice is kept here and re-applied on the way in (#22).
 */
describe('skills a session has switched off', () => {
  it('starts a session with nothing switched off', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.send('s1', 'x');

    expect(client.resumeSession).toHaveBeenCalledWith('s1', expect.objectContaining({ disabledSkills: [] }));
  });

  it('hands the choice back to a session being resumed', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.setSkillEnabled('s-resume', 'agent-creator', false);

    await runtime.send('s-resume', 'x');

    expect(client.resumeSession).toHaveBeenCalledWith(
      's-resume',
      expect.objectContaining({ disabledSkills: ['agent-creator'] }),
    );
  });

  it('reports what a session has switched off without loading it', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.setSkillEnabled('s-cold', 'agent-creator', false);

    expect(runtime.disabledSkills('s-cold')).toEqual(['agent-creator']);
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  // A loaded session would otherwise keep the skill until something evicted it.
  it('tells a session that is already loaded', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.send('s-live', 'x');
    const session = await client.resumeSession.mock.results[0].value;

    await runtime.setSkillEnabled('s-live', 'agent-creator', false);

    expect(session.rpc.options.update).toHaveBeenCalledWith({ disabledSkills: ['agent-creator'] });
  });

  it('switches one back on', async () => {
    const { runtime } = makeRuntime();
    await runtime.setSkillEnabled('s-back', 'agent-creator', false);

    await runtime.setSkillEnabled('s-back', 'agent-creator', true);

    expect(runtime.disabledSkills('s-back')).toEqual([]);
  });
});

describe('environment', () => {
  /** Give the client fake the three server surfaces the environment is assembled from. */
  function withEnvironment(runtimeParts: ReturnType<typeof makeRuntime>) {
    const rpc = runtimeParts.client.rpc as unknown as Record<string, unknown>;
    rpc.instructions = {
      discover: vi.fn(async (_params: { projectPaths?: string[] }) => ({
        sources: [
          {
            id: 'home-copilot',
            label: 'Home copilot-instructions.md',
            sourcePath: 'C:\\Users\\x\\.copilot\\copilot-instructions.md',
            content: '# Rules',
            type: 'home',
            location: 'user',
          },
        ],
      })),
    };
    rpc.extensions = {
      discover: vi.fn(async () => ({
        extensions: [
          {
            id: 'plugin:awesome-copilot/thing',
            name: 'thing',
            path: 'C:\\x\\thing.js',
            source: 'plugin',
            enabled: true,
            plugin: { name: 'awesome-copilot' },
          },
        ],
        mode: 'load_and_augment',
      })),
    };
    rpc.skills = {
      discover: vi.fn(async (_params: { projectPaths?: string[] }) => ({
        skills: [
          {
            name: 'agent-creator',
            commandName: 'agent-creator',
            description: 'Build a custom agent',
            source: 'personal-copilot',
            userInvocable: true,
            enabled: true,
            path: 'C:\\Users\\x\\.copilot\\skills\\agent-creator\\SKILL.md',
          },
          {
            name: 'context-map',
            commandName: 'context-engineering:context-map',
            description: 'Map the files a task touches',
            source: 'plugin',
            userInvocable: true,
            enabled: false,
          },
        ],
        errors: [],
      })),
    };
    return rpc;
  }

  it('passes on the skills the runtime could not read', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);
    (rpc.skills as { discover: unknown }).discover = vi.fn(async () => ({
      skills: [],
      errors: ['pdf: SKILL.md has no description'],
    }));

    const environment = await parts.runtime.environment('C:\\repo');

    expect(environment.skillErrors).toEqual(['pdf: SKILL.md has no description']);
  });

  // Older runtimes omit the field rather than sending an empty list.
  it('treats absent failures as none', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);
    (rpc.skills as { discover: unknown }).discover = vi.fn(async () => ({ skills: [] }));

    const environment = await parts.runtime.environment('C:\\repo');

    expect(environment.skillErrors).toEqual([]);
  });
  it('gathers instructions, plugins and extensions together', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    const environment = await parts.runtime.environment('C:\\repo');

    expect(environment.instructions).toEqual([
      {
        id: 'home-copilot',
        label: 'Home copilot-instructions.md',
        sourcePath: 'C:\\Users\\x\\.copilot\\copilot-instructions.md',
        content: '# Rules',
        type: 'home',
        location: 'user',
      },
    ]);
    expect(environment.plugins.map((plugin) => plugin.name)).toEqual([
      'context-engineering',
      'project-planning',
      'switched-off',
    ]);
    expect(environment.extensionMode).toBe('load_and_augment');
  });

  it('names the plugin an extension came from', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    const { extensions } = await parts.runtime.environment('C:\\repo');

    expect(extensions[0]).toMatchObject({ id: 'plugin:awesome-copilot/thing', plugin: 'awesome-copilot' });
  });

  it('lists the skills a session here would be offered', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    const { skills } = await parts.runtime.environment('C:\\repo');

    expect(skills).toEqual([
      {
        name: 'agent-creator',
        commandName: 'agent-creator',
        description: 'Build a custom agent',
        source: 'personal-copilot',
        userInvocable: true,
        enabled: true,
        path: 'C:\\Users\\x\\.copilot\\skills\\agent-creator\\SKILL.md',
      },
      {
        name: 'context-map',
        commandName: 'context-engineering:context-map',
        description: 'Map the files a task touches',
        source: 'plugin',
        userInvocable: true,
        enabled: false,
      },
    ]);
  });

  // Discovery is per project, as instructions are: a repository can carry its own skills.
  it('looks for skills in the working directory', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);

    await parts.runtime.environment('C:\\repo');

    const discover = (rpc.skills as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({ projectPaths: ['C:\\repo'] });
  });

  it('keeps a plugin the reader has disabled, saying so', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    const { plugins } = await parts.runtime.environment('C:\\repo');

    expect(plugins.find((plugin) => plugin.name === 'switched-off')?.enabled).toBe(false);
  });

  it('offers the working directory as a project path', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);

    await parts.runtime.environment('C:\\repo');

    const discover = (rpc.instructions as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({ projectPaths: ['C:\\repo'] });
  });

  it('asks about no project at all when there is no working directory', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);

    await parts.runtime.environment();

    const discover = (rpc.instructions as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({});
  });

  it('resumes nothing to answer', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    await parts.runtime.environment('C:\\repo');

    expect(parts.client.resumeSession).not.toHaveBeenCalled();
    expect(parts.client.createSession).not.toHaveBeenCalled();
  });
});
