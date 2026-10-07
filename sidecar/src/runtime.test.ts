import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join, sep } from 'node:path';
import type { CopilotSession, ExitPlanModeRequest, ExitPlanModeResult } from '@github/copilot-sdk';

import { copilotHome } from './paths.js';
import { SessionRuntime, type RuntimeOptions } from './runtime.js';

/**
 * The one reader a cold session's mode comes from, stubbed so a test can put a session's log
 * into a mode without a fixture directory. Everything else in the module is the real thing.
 */
const { lastMode } = vi.hoisted(() => ({ lastMode: vi.fn(async () => 'interactive') }));
const { lastUsage } = vi.hoisted(() => ({ lastUsage: vi.fn(async () => null as unknown) }));
vi.mock('./eventLog.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lastMode,
  lastUsage,
}));

/**
 * What a session's workspace file says it is called, stubbed so a test can put a session in
 * a naming state without a fixture directory. The rules that read it are #197's.
 */
const { nameState } = vi.hoisted(() => ({
  nameState: vi.fn(() => ({ name: null as string | null, named: false })),
}));
vi.mock('./sessionIndex.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nameState,
}));

/**
 * Whether the agent is told to add a co-author trailer, stubbed so a test can answer for
 * the CLI's settings file without writing one. Its own module proves how the file is read;
 * what the runtime decides is whether a session is told the answer at all.
 */
const { coauthorEnabled } = vi.hoisted(() => ({ coauthorEnabled: vi.fn(() => true) }));
vi.mock('./cliSettings.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coauthorEnabled,
}));

/**
 * The bin, stubbed so a test can say whether there was anything to move without a fixture
 * directory. What it does with one is its own module's to prove; what the runtime decides
 * is whether to reach for it at all.
 *
 * `binSession` answers false by default, which is what a session with no directory on disk
 * gets - which is every session in this file.
 */
const bin = vi.hoisted(() => ({
  binSession: vi.fn(() => false),
  binnedSessions: vi.fn((): unknown[] => []),
  restoreSession: vi.fn(() => true),
  sweepBin: vi.fn(() => 0),
}));
vi.mock('./recycleBin.js', () => bin);

beforeEach(() => {
  coauthorEnabled.mockReset().mockReturnValue(true);
  bin.binSession.mockReset().mockReturnValue(false);
  bin.binnedSessions.mockReset().mockReturnValue([]);
  bin.restoreSession.mockReset().mockReturnValue(true);
  bin.sweepBin.mockReset().mockReturnValue(0);
});

/** Tied to the SDK's own signature so a shape change fails the build rather than the fake. */
type ContextAttribution = Awaited<ReturnType<CopilotSession['rpc']['metadata']['getContextAttribution']>>;
/** The same, for the command result whose `mode` follow-up was being dropped (#167). */
type InvokeResult = Awaited<ReturnType<CopilotSession['rpc']['commands']['invoke']>>;
/** And for the usage metrics, so a change to what the runtime accounts for fails the build. */
type UsageMetrics = Awaited<ReturnType<CopilotSession['rpc']['usage']['getMetrics']>>;
/** And for the two halves of the mode surface, which report more than the mode itself. */
type ModeGetResult = Awaited<ReturnType<CopilotSession['rpc']['mode']['get']>>;
type ModeSetResult = Awaited<ReturnType<CopilotSession['rpc']['mode']['set']>>;

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
    setModel: vi.fn(async (_model: string, _options?: Record<string, unknown>) => undefined),
    rpc: {
      history: {
        listRewindPoints: vi.fn(
          async (): Promise<{
            fileChangeTrackingEnabled: boolean;
            unavailableReason?: string;
            points: Record<string, unknown>[];
          }> => ({ fileChangeTrackingEnabled: true, points: [] }),
        ),
        previewRewind: vi.fn(
          async (
            _params: { eventId: string },
          ): Promise<{ available: boolean; reason?: string; fileCount: number; files: Record<string, unknown>[] }> => ({
            available: true,
            fileCount: 0,
            files: [],
          }),
        ),
        rewind: vi.fn(
          async (
            _params: { eventId: string; mode: string },
          ): Promise<{
            outcome: string;
            eventsRemoved?: number;
            restoredFiles: string[];
            skippedFiles: { path: string; reason: string }[];
            error?: string;
          }> => ({ outcome: 'success', restoredFiles: [], skippedFiles: [] }),
        ),
      },
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
        removeAt: vi.fn(async (_params: { id: string }) => ({ removed: true })),
        updateText: vi.fn(async (_params: { id: string; prompt: string; displayPrompt?: string }) => ({ updated: true })),
        moveItem: vi.fn(async (_params: { id: string; toPosition: number }) => ({ changed: true })),
        clear: vi.fn(async () => undefined),
      },
      commands: {
        list: vi.fn(async () => ({ commands: [] })),
        enqueue: vi.fn(async (_params: { command: string; displayText?: string }) => ({ queued: true })),
        invoke: vi.fn(async (_params: { name: string; input?: string }): Promise<InvokeResult> => ({ kind: 'completed' })),
      },
      mode: {
        get: vi.fn(async (): Promise<ModeGetResult> => 'interactive'),
        set: vi.fn(
          async (_params: { mode: string }): Promise<ModeSetResult> => ({ status: 'unchanged', modelChanged: false }),
        ),
      },
      // Titling a new session asks its model a question of the app's own and sets the
      // answer as a name nobody chose (#197).
      permissions: {
        setMode: vi.fn(async (_params: { mode: string }) => undefined),
        paths: {
          list: vi.fn(async () => ({ directories: [] as string[], primary: 'C:\\repo' })),
          add: vi.fn(async (_params: { path: string }) => ({ success: true })),
          isPathWithinAllowedDirectories: vi.fn(async (_params: { path: string }) => ({ allowed: true })),
        },
      },
      name: {
        setAuto: vi.fn(async (_params: { summary: string }) => ({ applied: true })),
        set: vi.fn(async (_params: { name: string }) => undefined),
      },
      ui: {
        ephemeralQuery: vi.fn(async (_params: { question: string }) => ({
          answer: '<session-title>A Written Title</session-title>',
        })),
      },
      model: {
        getCurrent: vi.fn(async () => ({ modelId: 'a-named-model' })),
      },
      agent: {
        select: vi.fn(async (_params: { name: string }) => ({})),
        deselect: vi.fn(async () => undefined),
      },
      usage: {
        getMetrics: vi.fn(async (): Promise<UsageMetrics> => ({
          totalPremiumRequestCost: 390,
          totalUserRequests: 0,
          totalNanoAiu: 1_057_768_750_000,
          totalApiDurationMs: 331_549,
          sessionStartTime: '2026-09-13T22:54:00.166Z',
          lastCallInputTokens: 0,
          lastCallOutputTokens: 0,
          codeChanges: { linesAdded: 136, linesRemoved: 8, filesModifiedCount: 5, filesModified: [] },
          modelMetrics: {
            'claude-opus-5': {
              requests: { count: 51, cost: 300 },
              usage: {
                inputTokens: 4_242_694,
                outputTokens: 21_306,
                cacheReadTokens: 3_657_572,
                cacheWriteTokens: 585_020,
                reasoningTokens: 0,
              },
              totalNanoAiu: 1_057_768_750_000,
            },
          },
        })),
      },
      options: {
        update: vi.fn(async (_params: { disabledSkills?: string[] }) => ({ success: true })),
      },
      metadata: {
        getContextAttribution: vi.fn(async (): Promise<ContextAttribution> => ({          contextAttribution: {
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
  /** Typed from the SDK, so a change to either end of the plan exchange fails the build. */
  const planHandlers = new Map<string, (request: ExitPlanModeRequest) => Promise<ExitPlanModeResult>>();

  const client = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => []),
    // Titling a session on `auto` needs a model that can answer, and picks the cheapest
    // named one it is offered (#197). The expensive one is first, so preferring the cheap
    // one and merely taking the first are different answers.
    listModels: vi.fn(async () => [{ id: 'auto' }, { id: 'an-expensive-model' }, { id: 'a-haiku-model' }]),
    rpc: {
      // Hands back a new id, and leaves the source alone - which is only true because the
      // runtime loads it first. The real one empties a source it is not holding (#196).
      sessions: {
        fork: vi.fn(async ({ sessionId, name }: { sessionId: string; name?: string }) => ({
          sessionId: `${sessionId}-fork`,
          name: name ?? null,
        })),
      },
      commands: {
        list: vi.fn(async () => ({
          commands: [
            {
              name: 'add-dir',
              description: 'Allow a directory',
              aliases: [],
              input: { hint: 'directory', required: true, completion: 'directory' },
              allowDuringAgentExecution: true,
            },
          ],
        })),
      },
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
      hooks: {
        discover: vi.fn(async (_params: { projectPaths?: string[] }) => ({
          hooks: [],
          warnings: [],
          errors: [],
        })),
      },
    },
    resumeSession: vi.fn(
      async (
        id: string,
        config: {
          onPermissionRequest: (r: unknown) => unknown;
          onUserInputRequest?: (r: unknown) => unknown;
          onExitPlanModeRequest?: (r: ExitPlanModeRequest) => Promise<ExitPlanModeResult>;
        },
      ) => {
        const session = makeSession(id);
        sessions.set(id, session);
        permissionHandlers.set(id, config.onPermissionRequest);
        if (config.onUserInputRequest) elicitationHandlers.set(id, config.onUserInputRequest);
        if (config.onExitPlanModeRequest) planHandlers.set(id, config.onExitPlanModeRequest);
        return session;
      },
    ),
    createSession: vi.fn(async (_config: Record<string, unknown>) => {
      const session = { ...makeSession('made'), sessionId: 'made' };
      sessions.set('made', session);
      return session;
    }),
    deleteSession: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
  };

  const runtime = new SessionRuntime({
    idleTimeoutMs: 0, // Timers would make these tests about scheduling rather than rules.
    createClient: async () => client as never,
    ...options,
  });

  return { runtime, client, sessions, permissionHandlers, elicitationHandlers, planHandlers };
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

  it('keeps the runtime input rules needed to complete a command', async () => {
    const { runtime } = makeRuntime();

    expect(await runtime.commands()).toEqual([
      {
        name: 'add-dir',
        description: 'Allow a directory',
        aliases: [],
        hint: 'directory',
        required: true,
        completion: 'directory',
        allowDuringTurn: true,
      },
    ]);
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

  /**
   * The opposite of evicting, and the reason evicting exists: nothing is resumed until it is
   * needed, so the first message of the day waits on a resume. Waking one pays that while
   * the reader is still reading (#107).
   */
  describe('waking a session', () => {
    it('resumes one that is not loaded', async () => {
      const { runtime, client } = makeRuntime();

      await runtime.load('cold');

      expect(runtime.isActive('cold')).toBe(true);
      expect(client.resumeSession).toHaveBeenCalledTimes(1);
    });

    it('says it is coming before it arrives, since a resume is not instant', async () => {
      // The row the reader just pressed has to answer, and the only thing that knows a
      // resume has begun is the thing beginning it.
      const seen: [string, boolean, boolean | undefined][] = [];
      const { runtime } = makeRuntime({
        onLoadedChange: (id: string, loaded: boolean, loading?: boolean) => seen.push([id, loaded, loading]),
      });

      await runtime.load('cold');

      expect(seen).toEqual([
        ['cold', false, true],
        ['cold', true, false],
      ]);
    });

    it('takes it back when the resume fails, so a row does not pulse for ever', async () => {
      const seen: boolean[] = [];
      const { runtime, client } = makeRuntime({
        onLoadedChange: (_id: string, _loaded: boolean, loading?: boolean) => seen.push(loading === true),
      });
      client.resumeSession.mockRejectedValue(new Error('no such session'));

      await expect(runtime.load('cold')).rejects.toThrow(/no such session/);

      expect(seen).toEqual([true, false]);
    });

    it('says so, so the list can move it', async () => {
      const seen: [string, boolean][] = [];
      const { runtime } = makeRuntime({ onLoadedChange: (id: string, on: boolean) => seen.push([id, on]) });

      await runtime.load('cold');

      expect(seen).toContainEqual(['cold', true]);
    });

    it('resumes nothing for one already loaded', async () => {
      const { runtime, client, sessions } = makeRuntime();
      await sendAndFinish({ runtime, sessions }, 'warm');
      const before = client.resumeSession.mock.calls.length;

      await runtime.load('warm');

      expect(client.resumeSession).toHaveBeenCalledTimes(before);
      expect(runtime.isActive('warm')).toBe(true);
    });

    it('resumes once when asked twice at the same moment', async () => {
      const { runtime, client } = makeRuntime();

      await Promise.all([runtime.load('cold'), runtime.load('cold')]);

      expect(client.resumeSession).toHaveBeenCalledTimes(1);
    });

    it('can be sent to straight away, without resuming again', async () => {
      const { runtime, client, sessions } = makeRuntime();
      await runtime.load('cold');

      await sendAndFinish({ runtime, sessions }, 'cold');

      expect(client.resumeSession).toHaveBeenCalledTimes(1);
    });
  });

  it('lets a session go before asking the CLI to destroy it', async () => {
    // The CLI closes the session too, but only on its own side. Skipping evict would leave
    // this runtime holding an entry, a subscription and a loaded flag for something gone.
    const { runtime, client, sessions } = makeRuntime();
    await sendAndFinish({ runtime, sessions }, 'doomed');
    expect(runtime.isActive('doomed')).toBe(true);
    // Held now, because the CLI drops it from its own map as part of deleting.
    const held = sessions.get('doomed');

    await runtime.deleteSession('doomed');

    expect(held?.disconnected).toBe(true);
    expect(runtime.isActive('doomed')).toBe(false);
    expect(client.deleteSession).toHaveBeenCalledExactlyOnceWith('doomed');
  });

  it('deletes a session it was never holding', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.deleteSession('never-opened');

    expect(client.deleteSession).toHaveBeenCalledExactlyOnceWith('never-opened');
  });

  it('says a session is no longer loaded before the CLI is asked', async () => {
    // Reversed, the app would hear the session is gone while still being told it is loaded.
    // A resume in flight says nothing about either, so it is left out rather than counted.
    const order: string[] = [];
    const { runtime, sessions, client } = makeRuntime({
      onLoadedChange: (_id: string, loaded: boolean, loading?: boolean) => {
        if (loading !== true) order.push(loaded ? 'loaded' : 'unloaded');
      },
    });
    client.deleteSession.mockImplementation(async () => {
      order.push('deleted');
    });
    await sendAndFinish({ runtime, sessions }, 'doomed');

    await runtime.deleteSession('doomed');

    expect(order).toEqual(['loaded', 'unloaded', 'deleted']);
  });

  it('leaves the session loaded when the CLI refuses to delete it', async () => {
    // Evicting first means a refusal costs the resident session, which is the lesser of the
    // two: what must not happen is a runtime still holding one the CLI destroyed.
    const { runtime, client, sessions } = makeRuntime();
    client.deleteSession.mockRejectedValue(new Error('Session file not found for doomed'));
    await sendAndFinish({ runtime, sessions }, 'doomed');

    await expect(runtime.deleteSession('doomed')).rejects.toThrow(/Session file not found/);
    expect(runtime.isActive('doomed')).toBe(false);
  });

  /**
   * Forking a session the CLI is not holding rewrites the source's log down to the fork
   * notice alone and loses everything behind it - measured on 1.0.88 as nine events reduced
   * to one, leaving a log that no longer begins with `session.start` and so cannot be
   * reopened (#196). Loading first is the whole of the defence, so these are about the load
   * rather than about the fork.
   */
  describe('forking a session', () => {
    it('loads the source before forking it, because a cold fork empties it', async () => {
      const { runtime, client } = makeRuntime();

      const made = await runtime.forkSession('source');

      expect(client.resumeSession).toHaveBeenCalledWith('source', expect.anything());
      expect(client.rpc.sessions.fork).toHaveBeenCalledWith({ sessionId: 'source' });
      expect(made).toBe('source-fork');
    });

    it('does not fork at all when the source cannot be opened', async () => {
      const { runtime, client } = makeRuntime();
      client.resumeSession.mockRejectedValue(new Error('Session history cannot be recovered'));

      await expect(runtime.forkSession('wrecked')).rejects.toThrow(/could not be opened first/);
      expect(client.rpc.sessions.fork).not.toHaveBeenCalled();
    });

    // The reason has to travel: "it could not be opened" is the whole of why it was refused.
    it('says what stopped it, rather than only that something did', async () => {
      const { runtime, client } = makeRuntime();
      client.resumeSession.mockRejectedValue(new Error('Session history cannot be recovered'));

      await expect(runtime.forkSession('wrecked')).rejects.toThrow(/history cannot be recovered/);
    });

    it('forks a session that is already loaded without resuming it twice', async () => {
      const { runtime, client, sessions } = makeRuntime();
      await sendAndFinish({ runtime, sessions }, 'warm');
      client.resumeSession.mockClear();

      await runtime.forkSession('warm');

      expect(client.resumeSession).not.toHaveBeenCalled();
      expect(client.rpc.sessions.fork).toHaveBeenCalledWith({ sessionId: 'warm' });
    });

    it('passes a name on when it is given one, and leaves it out when it is not', async () => {
      const { runtime, client } = makeRuntime();

      await runtime.forkSession('source', 'a second opinion');
      expect(client.rpc.sessions.fork).toHaveBeenLastCalledWith({
        sessionId: 'source',
        name: 'a second opinion',
      });

      await runtime.forkSession('source');
      expect(client.rpc.sessions.fork).toHaveBeenLastCalledWith({ sessionId: 'source' });
    });

    // A fork nobody can name is one the reader cannot be sent to.
    it('refuses an answer with no new session in it', async () => {
      const { runtime, client } = makeRuntime();
      client.rpc.sessions.fork.mockResolvedValue({ sessionId: '', name: null });

      await expect(runtime.forkSession('source')).rejects.toThrow(/did not say what the new one is called/);
    });

    /** The source has just been read from end to end, so it is the last thing to evict. */
    it('counts the source as freshly used, having just resumed it', async () => {
      const { runtime } = makeRuntime({ maxLoadedSessions: 2 });
      await runtime.load('a');
      await runtime.load('b');

      await runtime.forkSession('a');
      await runtime.load('c');

      expect(runtime.isActive('a')).toBe(true);
      expect(runtime.isActive('b')).toBe(false);
    });
  });

  /**
   * With a retention the session's directory is moved out of the CLI's reach and the CLI is
   * not told at all: it lists sessions by reading that directory, so asking it to delete one
   * that has moved would only be asking it to fail.
   */
  describe('with somewhere to put it', () => {
    it('bins the session rather than deleting it', async () => {
      const { runtime, client } = makeRuntime();
      bin.binSession.mockReturnValue(true);

      await runtime.deleteSession('doomed');

      expect(bin.binSession).toHaveBeenCalledOnce();
      expect(client.deleteSession).not.toHaveBeenCalled();
    });

    it('lets go of the session before moving what it wrote', async () => {
      const order: string[] = [];
      const { runtime, sessions } = makeRuntime({
        onLoadedChange: (_id: string, loaded: boolean, loading?: boolean) => {
          if (loading !== true) order.push(loaded ? 'loaded' : 'unloaded');
        },
      });
      bin.binSession.mockImplementation(() => {
        order.push('binned');
        return true;
      });
      await sendAndFinish({ runtime, sessions }, 'doomed');

      await runtime.deleteSession('doomed');

      expect(order).toEqual(['loaded', 'unloaded', 'binned']);
    });

    it('deletes outright when the reader keeps nothing', async () => {
      const { runtime, client } = makeRuntime();
      bin.binSession.mockReturnValue(true);
      await runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, binRetentionDays: 0 });

      await runtime.deleteSession('doomed');

      expect(bin.binSession).not.toHaveBeenCalled();
      expect(client.deleteSession).toHaveBeenCalledExactlyOnceWith('doomed');
    });

    // A session with no directory has nothing to keep, and the CLI can say why.
    it('asks the CLI when there was nothing to move', async () => {
      const { runtime, client } = makeRuntime();
      bin.binSession.mockReturnValue(false);

      await runtime.deleteSession('doomed');

      expect(client.deleteSession).toHaveBeenCalledExactlyOnceWith('doomed');
    });

    it('sweeps the bin whenever it is told the rules', async () => {
      const { runtime } = makeRuntime();

      await runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, binRetentionDays: 3 });

      expect(bin.sweepBin).toHaveBeenCalledWith(3);
    });

    /** Rules that say nothing about the bin should not quietly empty it. */
    it('keeps the retention it had when it is not given one', async () => {
      const { runtime } = makeRuntime();
      await runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, binRetentionDays: 3 });

      await runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0 });

      expect(bin.sweepBin).toHaveBeenLastCalledWith(3);
    });

    it('puts a binned session back when asked', async () => {      const { runtime } = makeRuntime();

      expect(runtime.restoreSession('doomed')).toBe(true);

      expect(bin.restoreSession).toHaveBeenCalledExactlyOnceWith('doomed');
    });

    /**
     * Otherwise shortening the retention and then reading the bin is a race between the
     * sweep and the read, and whoever asked sees rows that are already on their way out.
     */
    it('applies the rules before saying what is in the bin', async () => {
      const order: string[] = [];
      const { runtime } = makeRuntime();
      bin.sweepBin.mockImplementation(() => {
        order.push('swept');
        return 0;
      });
      bin.binnedSessions.mockImplementation(() => {
        order.push('listed');
        return [];
      });
      await runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, binRetentionDays: 3 });
      order.length = 0;

      runtime.binnedSessions();

      expect(order).toEqual(['swept', 'listed']);
      expect(bin.sweepBin).toHaveBeenLastCalledWith(3);
    });
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
  /**
   * Let the prompt reach the UI before reading what it was told.
   *
   * The prompt is raised after the runtime has been asked whether the path is already
   * allowed (#210), so the call it makes lands a few microtasks after the request that
   * caused it. Kept separate from the call rather than wrapping it: a helper that returned
   * the pending answer would be awaited, and awaiting a promise that resolves to a promise
   * waits for that one too - which is the answer nobody has given yet.
   */
  const prompted = async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  };

  /**
   * Who is asking, when the session's own agent is not the one asking (#229).
   *
   * A permission request names a tool call and nothing else, so the asking agent is worked
   * out from the event that started that call. Measured across every log on this machine:
   * `tool.execution_start` carries both, and always arrived before the request about it.
   */
  describe('who is asking', () => {
    const started = (toolCallId: string, agentId?: string) => ({
      type: 'tool.execution_start',
      data: { toolCallId, toolName: 'write' },
      ...(agentId ? { agentId } : {}),
    });

    /** What the runtime sends when a delegated agent begins work. */
    const announced = (agentId: string, toolCallId: string, names: Record<string, string>) => ({
      type: 'subagent.started',
      agentId,
      data: { toolCallId, ...names },
    });

    /** Raise a request about `toolCallId`, after whatever events came first, and report who asked. */
    const asking = async (
      before: (sessions: ReturnType<typeof makeRuntime>['sessions']) => void,
      toolCallId: string,
    ) => {
      const onPermissionRequest = vi.fn();
      const { runtime, sessions, permissionHandlers } = makeRuntime({ onPermissionRequest });
      await runtime.send('a', 'x');
      before(sessions);

      void permissionHandlers.get('a')?.({ kind: 'write', toolCallId });
      await prompted();
      return onPermissionRequest.mock.calls[0]?.[5];
    };

    it('says nothing where the session asked for itself', async () => {
      expect(await asking((s) => s.get('a')?.emit(started('call-1')), 'call-1')).toBeUndefined();
    });

    it('names the subagent that asked', async () => {
      const askedBy = await asking((s) => {
        s.get('a')?.emit(announced('agent-1', 'task-1', { agentName: 'explore' }));
        s.get('a')?.emit(started('call-1', 'agent-1'));
      }, 'call-1');

      expect(askedBy).toEqual({ agentId: 'agent-1', name: 'explore' });
    });

    it('prefers what the subagent is shown as', async () => {
      const askedBy = await asking((s) => {
        s.get('a')?.emit(
          announced('agent-1', 'task-1', { agentName: 'explore', agentDisplayName: 'Explore Agent' }),
        );
        s.get('a')?.emit(started('call-1', 'agent-1'));
      }, 'call-1');

      expect(askedBy).toEqual({ agentId: 'agent-1', name: 'Explore Agent' });
    });

    /**
     * A session attached to part-way through a run has the tool call but never saw the
     * announcement that named the agent making it. That a delegated agent is asking is
     * worth saying without its name.
     */
    it('still says a subagent asked when it was never named', async () => {
      const askedBy = await asking((s) => s.get('a')?.emit(started('call-1', 'agent-1')), 'call-1');

      expect(askedBy).toEqual({ agentId: 'agent-1' });
    });

    /**
     * An announcement names the call that created the agent without having made it, so
     * counting it would make a delegated agent the one asking permission to delegate it.
     */
    it('does not make a subagent the one that asked for it', async () => {
      const askedBy = await asking((s) => {
        s.get('a')?.emit(started('task-1'));
        s.get('a')?.emit(announced('agent-1', 'task-1', { agentName: 'explore' }));
      }, 'task-1');

      expect(askedBy).toBeUndefined();
    });

    /**
     * The same holds at the other end of a run, and matters more there: a finished agent
     * names the call that started it long after the session's own agent made that call,
     * so a late arrival would otherwise overwrite who really asked. Counted on these logs:
     * 625 `subagent.completed` and 17 `subagent.failed` carry both a call and an agent.
     */
    it('does not let a finished subagent claim the call that started it', async () => {
      const askedBy = await asking((s) => {
        s.get('a')?.emit(started('task-1'));
        s.get('a')?.emit({ type: 'subagent.completed', agentId: 'agent-1', data: { toolCallId: 'task-1' } });
      }, 'task-1');

      expect(askedBy).toBeUndefined();
    });

    /** Tool call ids are the runtime's, not this app's, so two sessions can hold the same one. */
    it('keeps one session from answering for another', async () => {
      const onPermissionRequest = vi.fn();
      const { runtime, sessions, permissionHandlers } = makeRuntime({ onPermissionRequest });
      await runtime.send('a', 'x');
      await runtime.send('b', 'x');
      sessions.get('b')?.emit(started('call-1', 'agent-1'));

      void permissionHandlers.get('a')?.({ kind: 'write', toolCallId: 'call-1' });
      await prompted();

      expect(onPermissionRequest.mock.calls[0]?.[5]).toBeUndefined();
    });
  });

  it('asks the user rather than deciding on their behalf', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    await prompted();
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
    await prompted();
    runtime.resolvePermission(onPermissionRequest.mock.calls[0]?.[1] as string, 'reject');
    await expect(pending).resolves.toEqual({ kind: 'reject' });
  });

  /**
   * Approving for the session has to name what is being approved.
   *
   * Without a rule the runtime has nothing to write down, so the approval covers the one
   * request and the next identical one asks again - which is what "Allow for session"
   * looked like it was failing to do. Measured against the real runtime: a second write
   * inside the working directory goes from asking every time to not asking at all.
   */
  describe('approving for the rest of the session', () => {
    const answer = async (request: Record<string, unknown>) => {
      const onPermissionRequest = vi.fn();
      const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
      await runtime.send('a', 'x');

      const pending = permissionHandlers.get('a')?.(request);
      await prompted();
      runtime.resolvePermission(onPermissionRequest.mock.calls[0]?.[1] as string, 'approve-for-session');
      return pending;
    };

    it('remembers writes as writes', async () => {
      await expect(answer({ kind: 'write', fileName: 'a.ts' })).resolves.toEqual({
        kind: 'approve-for-session',
        approval: { kind: 'write' },
      });
    });

    it('remembers reads as reads', async () => {
      await expect(answer({ kind: 'read', fileName: 'a.ts' })).resolves.toEqual({
        kind: 'approve-for-session',
        approval: { kind: 'read' },
      });
    });

    // The commands in front of the reader, rather than shell access at large.
    it('remembers the commands that were shown, not the shell', async () => {
      await expect(
        answer({
          kind: 'shell',
          commands: [
            { identifier: 'Write-Output hello', readOnly: false },
            { identifier: 'Get-ChildItem', readOnly: true },
          ],
        }),
      ).resolves.toEqual({
        kind: 'approve-for-session',
        approval: { kind: 'commands', commandIdentifiers: ['Write-Output hello', 'Get-ChildItem'] },
      });
    });

    it('remembers an MCP tool by its server and name', async () => {
      await expect(answer({ kind: 'mcp', serverName: 'github', toolName: 'search' })).resolves.toEqual({
        kind: 'approve-for-session',
        approval: { kind: 'mcp', serverName: 'github', toolName: 'search' },
      });
    });

    /**
     * A bare approval for a kind with no rule to give, which is what every kind did before
     * this. It approves what was asked and asks again next time, rather than inventing a
     * rule that might cover more than the reader saw.
     */
    it('approves without a rule when it has none to give', async () => {
      await expect(answer({ kind: 'something-new' })).resolves.toEqual({ kind: 'approve-for-session' });
    });

    it('approves without a rule when a shell request names no commands', async () => {
      await expect(answer({ kind: 'shell', commands: [] })).resolves.toEqual({
        kind: 'approve-for-session',
      });
    });

    /**
     * Two requests can be outstanding at once, so the rule has to come from the one being
     * answered rather than the one that arrived last.
     */
    it('builds the rule from the request that was answered', async () => {
      const onPermissionRequest = vi.fn();
      const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
      await runtime.send('a', 'x');

      const ask = permissionHandlers.get('a')!;
      const write = ask({ kind: 'write', fileName: 'a.ts' });
      const read = ask({ kind: 'read', fileName: 'b.ts' });
      await prompted();

      const first = onPermissionRequest.mock.calls[0]?.[1] as string;
      const second = onPermissionRequest.mock.calls[1]?.[1] as string;

      runtime.resolvePermission(second, 'approve-for-session');
      runtime.resolvePermission(first, 'approve-for-session');

      await expect(read).resolves.toEqual({
        kind: 'approve-for-session',
        approval: { kind: 'read' },
      });
      await expect(write).resolves.toEqual({
        kind: 'approve-for-session',
        approval: { kind: 'write' },
      });
    });
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
    await prompted();

    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
  });

  // The agent blocks on this promise, so every teardown path has to settle it.
  it('settles pending requests when the turn is aborted', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    await prompted();
    await runtime.abort('a');
    await expect(pending).resolves.toEqual({ kind: 'user-not-available' });
  });

  it('settles pending requests when the session is evicted', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    await prompted();
    await runtime.evict('a');
    await expect(pending).resolves.toEqual({ kind: 'user-not-available' });
  });

  it('settles pending requests on shutdown', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest });
    await runtime.send('a', 'x');

    const pending = permissionHandlers.get('a')?.({ kind: 'shell' });
    await prompted();
    await runtime.shutdown();
    await expect(pending).resolves.toEqual({ kind: 'user-not-available' });
  });

  /**
   * Giving up on the user unblocks the agent, but the prompt is still on screen: without
   * being told, the UI goes on offering buttons whose answer has nowhere left to go.
   */
  it('tells the UI when it gives up waiting for an answer', async () => {    const onPermissionResolved = vi.fn();
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
 * Plan mode's checkpoint: the agent stops so a human can read what it intends to do.
 *
 * The SDK approves every plan when no handler is registered, and registering one is also
 * what tells the runtime to ask in the first place, so an app that leaves it off skips the
 * checkpoint entirely without any sign that it did (#167).
 */
describe('plans awaiting approval', () => {
  const propose = (
    handlers: Map<string, (r: ExitPlanModeRequest) => Promise<ExitPlanModeResult>>,
    plan: Partial<ExitPlanModeRequest> = {},
  ) =>
    handlers.get('a')?.({
      summary: 'Rewrite the parser',
      planContent: '# Plan\n\n1. Do the thing',
      actions: ['exit_only', 'interactive', 'autopilot'],
      recommendedAction: 'interactive',
      ...plan,
    });

  it('registers a handler, which is what makes the runtime ask at all', async () => {
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest: vi.fn() });
    await runtime.send('a', 'x');
    expect(planHandlers.has('a')).toBe(true);
  });

  // A new session has to be asked too, and the client only offers the capability when the
  // handler is there, so its absence would be silent.
  it('registers the handler on a session it just made', async () => {
    const { runtime, client } = makeRuntime({ onPlanRequest: vi.fn() });
    await runtime.create();

    const config = client.createSession.mock.calls[0]?.[0];
    expect(config?.onExitPlanModeRequest).toBeInstanceOf(Function);
  });

  it('passes the plan, its actions and the recommendation to the UI', async () => {
    const onPlanRequest = vi.fn();
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest });
    await runtime.send('a', 'x');

    void propose(planHandlers);

    expect(onPlanRequest.mock.calls[0]?.[2]).toEqual({
      summary: 'Rewrite the parser',
      planContent: '# Plan\n\n1. Do the thing',
      actions: ['exit_only', 'interactive', 'autopilot'],
      recommendedAction: 'interactive',
    });
  });

  // The SDK types these as plain strings, so a new one must not reach the UI as a button
  // with nothing behind it.
  it('drops an action this build does not know how to offer', async () => {
    const onPlanRequest = vi.fn();
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest });
    await runtime.send('a', 'x');

    void propose(planHandlers, { actions: ['interactive', 'teleport'] });

    expect(onPlanRequest.mock.calls[0]?.[2]).toMatchObject({ actions: ['interactive'] });
  });

  it('falls back to an action it can draw when the recommendation is unknown', async () => {
    const onPlanRequest = vi.fn();
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest });
    await runtime.send('a', 'x');

    void propose(planHandlers, { actions: ['autopilot'], recommendedAction: 'teleport' });

    expect(onPlanRequest.mock.calls[0]?.[2]).toMatchObject({ recommendedAction: 'autopilot' });
  });

  // Nothing offered is recognisable, so there is no action to fall back to either. The UI
  // is left with approve or decline, which it can still draw.
  it('names a way forward even when none of the offered ones are known', async () => {
    const onPlanRequest = vi.fn();
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest });
    await runtime.send('a', 'x');

    void propose(planHandlers, { actions: ['teleport'], recommendedAction: 'teleport' });

    expect(onPlanRequest.mock.calls[0]?.[2]).toMatchObject({
      actions: [],
      recommendedAction: 'interactive',
    });
  });

  // Optional on the handler's request even though the event always carries it.
  it('shows the summary when the plan arrived without a body', async () => {
    const onPlanRequest = vi.fn();
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest });
    await runtime.send('a', 'x');

    void propose(planHandlers, { planContent: undefined });

    expect(onPlanRequest.mock.calls[0]?.[2]).toMatchObject({ planContent: 'Rewrite the parser' });
  });

  it('approves a plan with the way forward the reader chose', async () => {
    const onPlanRequest = vi.fn();
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest });
    await runtime.send('a', 'x');

    const decided = propose(planHandlers);
    runtime.resolvePlan(onPlanRequest.mock.calls[0]?.[1] as string, true, 'autopilot');

    await expect(decided).resolves.toEqual({ approved: true, selectedAction: 'autopilot' });
  });

  // Feedback is how a reader redirects a plan rather than abandoning it, so it has to
  // survive the trip back.
  it('turns a plan down with the reason, and no action it never chose', async () => {
    const onPlanRequest = vi.fn();
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest });
    await runtime.send('a', 'x');

    const decided = propose(planHandlers);
    runtime.resolvePlan(onPlanRequest.mock.calls[0]?.[1] as string, false, undefined, 'Use the old parser');

    await expect(decided).resolves.toEqual({ approved: false, feedback: 'Use the old parser' });
  });

  /**
   * Feedback left over from a reader who typed a complaint, thought better of it and
   * approved anyway would tell the agent it had been criticised when it had not.
   */
  it('leaves feedback out of an approval that happens to carry some', async () => {
    const onPlanRequest = vi.fn();
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest });
    await runtime.send('a', 'x');

    const decided = propose(planHandlers);
    runtime.resolvePlan(onPlanRequest.mock.calls[0]?.[1] as string, true, 'interactive', 'a stale draft');

    await expect(decided).resolves.toEqual({ approved: true, selectedAction: 'interactive' });
  });

  /** The fix for #167: nobody read it, so it is not approved. */
  it('refuses a plan when there is no UI to read it', async () => {
    const { runtime, planHandlers } = makeRuntime();
    await runtime.send('a', 'x');

    await expect(propose(planHandlers)).resolves.toEqual({ approved: false });
  });

  it('settles a pending plan when the session is evicted', async () => {
    const { runtime, planHandlers } = makeRuntime({ onPlanRequest: vi.fn() });
    await runtime.send('a', 'x');

    const decided = propose(planHandlers);
    await runtime.evict('a');

    await expect(decided).resolves.toEqual({ approved: false });
  });

  it('tells the UI when it gives up waiting for a decision', async () => {
    const onPlanResolved = vi.fn();
    const { runtime, planHandlers } = makeRuntime({
      onPlanRequest: vi.fn(),
      onPlanResolved,
      permissionTimeoutMs: 5,
    });
    await runtime.send('a', 'x');

    // Giving up is not consent: the value the agent gets back matters as much as the
    // notification, since this is the path a plan takes when nobody is watching.
    await expect(propose(planHandlers)).resolves.toEqual({ approved: false });
    expect(onPlanResolved).toHaveBeenCalledWith(expect.stringMatching(/^plan-/));
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
    // Sending marks the session busy, and a busy session is deliberately left alone.
    sessions.get('a')!.emit({ type: 'session.idle', data: {} });

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
 * `/autopilot` and `/interactive` are runtime commands, so they reach the session and
 * return `completed` - but the switch itself is the host's to perform. Dropping it made
 * both commands run, report success and change nothing, which is indistinguishable from a
 * command this app does not support except that it does not say so (#167).
 *
 * `/plan` is deliberately not the example here. Despite the name it reports no mode: it is
 * a prompt command that prefixes the message with `[[PLAN]]` and has the agent write a
 * plan.md. Plan mode is entered through `setMode`, not through it.
 */
describe('a command that changes the mode', () => {
  it('applies the mode the command asked for', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    const session = sessions.get('s1')!;
    session.rpc.commands.invoke.mockResolvedValueOnce({ kind: 'completed', mode: 'autopilot' });

    await runtime.invoke('s1', 'autopilot');

    expect(session.rpc.mode.set).toHaveBeenCalledWith({ mode: 'autopilot' });
  });

  it('reports the mode back, so the switch is not silent', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    sessions.get('s1')!.rpc.commands.invoke.mockResolvedValueOnce({ kind: 'completed', mode: 'interactive' });

    expect(await runtime.invoke('s1', 'interactive')).toEqual({ kind: 'done', mode: 'interactive' });
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

  /**
   * The same field on a different kind of result, which was left undone when #167 was
   * fixed on `completed` alone. A command that switches the mode and then writes a prompt
   * would otherwise have had its prompt sent in the mode it was already in.
   */
  it('applies a mode reported alongside a prompt, not only alongside a completion', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    const session = sessions.get('s1')!;
    session.rpc.commands.invoke.mockResolvedValueOnce({
      kind: 'agent-prompt',
      prompt: 'do the thing',
      displayPrompt: 'do the thing',
      mode: 'autopilot',
    });

    expect(await runtime.invoke('s1', 'autopilot')).toEqual({ kind: 'prompt', prompt: 'do the thing' });
    expect(session.rpc.mode.set).toHaveBeenCalledWith({ mode: 'autopilot' });
  });
});

/**
 * A command can change settings on its way past, whatever else it returns.
 *
 * The runtime says so with a flag it attaches to every kind of result, and this app shows
 * settings in a panel that would otherwise go on showing the values from before the command
 * ran. It was read on `completed` alone, which is where it happened to be noticed (#168).
 */
describe('a command that changes settings', () => {
  const invoking = async (result: Record<string, unknown>) => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'x');
    harness.sessions.get('s1')!.rpc.commands.invoke.mockResolvedValueOnce(result as never);
    return harness.runtime.invoke('s1', 'settings');
  };

  it.each([
    ['text', { kind: 'text', text: 'shown' }],
    ['agent-prompt', { kind: 'agent-prompt', prompt: 'p', displayPrompt: 'p' }],
    ['completed', { kind: 'completed' }],
    ['add-timeline-entry', { kind: 'add-timeline-entry', entry: { type: 'note', text: 'row' } }],
  ])('passes the flag on when it arrives with a %s result', async (_kind, result) => {
    expect(await invoking({ ...result, runtimeSettingsChanged: true })).toMatchObject({ settingsChanged: true });
  });

  /** A kind this build does not model can still have changed something on its way past. */
  it('passes it on even from a result it cannot otherwise use', async () => {
    expect(await invoking({ kind: 'subcommand-select', runtimeSettingsChanged: true })).toEqual({
      kind: 'unsupported',
      what: 'subcommand-select',
      settingsChanged: true,
    });
  });

  // Most commands change nothing, and saying they did would re-read the settings on every
  // command anyone runs.
  it('says nothing when the command changed nothing', async () => {
    expect(await invoking({ kind: 'completed', message: 'done' })).toEqual({ kind: 'done', message: 'done' });
  });

  /** False is the runtime saying it did not, which is not the same as declining to say. */
  it('treats an explicit false as nothing changed', async () => {
    expect(await invoking({ kind: 'completed', runtimeSettingsChanged: false })).toEqual({ kind: 'done' });
  });
});

/**
 * The mode a session is in, which the sidebar wants for every session it lists.
 *
 * Split by whether the session is loaded, because the two answers come from different
 * places for a reason: a cold session is read from its log so that labelling the list does
 * not resume anything, which is the cost this app exists to avoid.
 */
describe('the mode a session is in', () => {
  it('asks a loaded session, which holds the truth', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    sessions.get('s1')!.rpc.mode.get.mockResolvedValueOnce('autopilot');

    expect(await runtime.mode('s1')).toBe('autopilot');
  });

  // The whole point: the sidebar asks about every session it draws.
  it('does not load a cold session to ask', async () => {
    const { runtime, sessions } = makeRuntime();
    lastMode.mockResolvedValueOnce('plan');

    expect(await runtime.mode('cold')).toBe('plan');
    expect(sessions.size).toBe(0);
  });

  it('applies a mode the reader chose', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');

    await runtime.setMode('s1', 'plan');

    expect(sessions.get('s1')!.rpc.mode.set).toHaveBeenCalledWith({ mode: 'plan' });
  });

  /**
   * A switch can be refused, or held up waiting on a confirmation this app does not answer.
   * Echoing the request back would leave the reader looking at a mode the session is not in,
   * so the mode is read back rather than assumed.
   */
  it('answers with the mode that took, not the one asked for', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    sessions.get('s1')!.rpc.mode.get.mockResolvedValueOnce('interactive');

    expect(await runtime.setMode('s1', 'plan')).toEqual({ mode: 'interactive' });
  });

  // Entering plan mode can switch the model, which is not something to discover later.
  it('passes on what the runtime said about the switch', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    sessions
      .get('s1')!
      .rpc.mode.set.mockResolvedValueOnce({ status: 'changed', modelChanged: true, message: 'Plan model set\u001B[0m' });

    expect(await runtime.setMode('s1', 'plan')).toEqual({ mode: 'interactive', notice: 'Plan model set' });
  });

  // A warning is the more urgent of the two, so it is the one that gets shown.
  it('prefers a warning to a message', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    sessions
      .get('s1')!
      .rpc.mode.set.mockResolvedValueOnce({ status: 'changed', modelChanged: false, warning: 'careful', message: 'fine' });

    expect((await runtime.setMode('s1', 'plan')).notice).toBe('careful');
  });

  it('says nothing when the runtime had nothing to say', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('s1', 'x');

    expect(await runtime.setMode('s1', 'plan')).toEqual({ mode: 'interactive' });
  });

  // Unlike asking, choosing a mode is something the reader did on purpose.
  it('resumes a cold session to change its mode', async () => {
    const { runtime, sessions } = makeRuntime();

    await runtime.setMode('cold', 'plan');

    expect(sessions.get('cold')!.rpc.mode.set).toHaveBeenCalledWith({ mode: 'plan' });
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

    await runtime.discovery.agents();

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('asks about a project when given a directory, so its own agents are found', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.discovery.agents('C:\\repo');

    expect(client.rpc.agents.discover).toHaveBeenCalledWith({ projectPaths: ['C:\\repo'] });
  });

  /** A session that is not about a project has no project path, which is not an empty one. */
  it('asks about no project when given no directory', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.discovery.agents();

    expect(client.rpc.agents.discover).toHaveBeenCalledWith({});
  });

  it('keeps what a picker needs and drops what it does not', async () => {
    const { runtime } = makeRuntime();

    const [first] = await runtime.discovery.agents();

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

    const agents = await runtime.discovery.agents();

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

/**
 * The CLI's `includeCoAuthoredBy`, which reads like a git setting and is not one: the
 * runtime turns it into an instruction in the system prompt telling the model to write the
 * trailer itself.
 *
 * The CLI only sets it from its own two front ends, so a session made through the SDK was
 * told nothing and fell back to the runtime's own answer - which meant a reader who had
 * turned the trailer off still got one here (#205).
 */
describe('the commit trailer', () => {
  it('tells a new session what the reader asked for', async () => {
    coauthorEnabled.mockReturnValue(false);
    const { runtime, client } = makeRuntime();

    await runtime.create('C:\\repo');

    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ coauthorEnabled: false }));
  });

  it('leaves it on where the reader has not said otherwise', async () => {
    coauthorEnabled.mockReturnValue(true);
    const { runtime, client } = makeRuntime();

    await runtime.create('C:\\repo');

    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ coauthorEnabled: true }));
  });

  // Or a session would sign its commits differently depending on whether it had been
  // evicted since, which this app does constantly under its session cap.
  it('tells a resumed session the same thing', async () => {
    coauthorEnabled.mockReturnValue(false);
    const { runtime, client } = makeRuntime();

    await runtime.send('s1', 'x');

    expect(client.resumeSession).toHaveBeenCalledWith('s1', expect.objectContaining({ coauthorEnabled: false }));
  });

  /** Read per session, as the CLI reads it, so a change lands without restarting anything. */
  it('asks again for each session rather than once for the server', async () => {
    const { runtime } = makeRuntime();

    await runtime.create('C:\\repo');
    await runtime.create('C:\\repo');

    expect(coauthorEnabled).toHaveBeenCalledTimes(2);
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
    rpc.mcp = {
      discover: vi.fn(async (_params: { workingDirectory?: string }) => ({
        servers: [
          { name: 'context7', type: 'http', source: 'user', enabled: true },
          { name: 'from-a-plugin', type: 'stdio', source: 'plugin', sourcePlugin: 'awesome-copilot', enabled: false },
        ],
      })),
    };
    rpc.instructions = {
      discover: vi.fn(async (_params: { projectPaths?: string[] }) => ({        sources: [
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
      discover: vi.fn(async () => ({        extensions: [
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

    const environment = await parts.runtime.discovery.environment('C:\\repo');

    expect(environment.skillErrors).toEqual(['pdf: SKILL.md has no description']);
  });

  // Older runtimes omit the field rather than sending an empty list.
  it('treats absent failures as none', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);
    (rpc.skills as { discover: unknown }).discover = vi.fn(async () => ({ skills: [] }));

    const environment = await parts.runtime.discovery.environment('C:\\repo');

    expect(environment.skillErrors).toEqual([]);
  });
  it('gathers instructions, plugins and extensions together', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    const environment = await parts.runtime.discovery.environment('C:\\repo');

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

    const { extensions } = await parts.runtime.discovery.environment('C:\\repo');

    expect(extensions[0]).toMatchObject({ id: 'plugin:awesome-copilot/thing', plugin: 'awesome-copilot' });
  });

  it('lists the skills a session here would be offered', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    const { skills } = await parts.runtime.discovery.environment('C:\\repo');

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

    await parts.runtime.discovery.environment('C:\\repo');

    const discover = (rpc.skills as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({ projectPaths: ['C:\\repo'] });
  });

  it('keeps a plugin the reader has disabled, saying so', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    const { plugins } = await parts.runtime.discovery.environment('C:\\repo');

    expect(plugins.find((plugin) => plugin.name === 'switched-off')?.enabled).toBe(false);
  });

  it('offers the working directory as a project path', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);

    await parts.runtime.discovery.environment('C:\\repo');

    const discover = (rpc.instructions as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({ projectPaths: ['C:\\repo'] });
  });

  it('asks about no project at all when there is no working directory', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);

    await parts.runtime.discovery.environment();

    const discover = (rpc.instructions as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({});
  });

  it('resumes nothing to answer', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    await parts.runtime.discovery.environment('C:\\repo');

    expect(parts.client.resumeSession).not.toHaveBeenCalled();
    expect(parts.client.createSession).not.toHaveBeenCalled();
  });
});

/**
 * What a session has spent, which unlike its context window is a fact about its past and is
 * written down as it goes. So this answers for a cold session too, and still resumes
 * nothing - the rule the whole app is built on.
 */
describe('what a session has cost', () => {
  it('asks a loaded session, which can account for the detail', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');

    const usage = await runtime.usage('s1');

    expect(sessions.get('s1')!.rpc.usage.getMetrics).toHaveBeenCalled();
    expect(usage).toMatchObject({
      premiumRequests: 390,
      aiu: 1057.76875,
      loaded: true,
      requests: 51,
      apiDurationMs: 331_549,
      codeChanges: { linesAdded: 136, linesRemoved: 8, filesModified: 5 },
    });
  });

  it('adds the token counts up across models', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('s1', 'x');

    expect((await runtime.usage('s1'))?.tokens).toEqual({
      input: 4_242_694,
      output: 21_306,
      cacheRead: 3_657_572,
      cacheWrite: 585_020,
      reasoning: 0,
    });
  });

  /**
   * Both read zero on every resumed session measured, so passing them on would report a
   * session that has done plenty of work as having made no requests at all.
   */
  it('does not pass on the figures that are only true of a live session', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('s1', 'x');

    const usage = await runtime.usage('s1');

    expect(usage).not.toHaveProperty('totalUserRequests');
    expect(usage).not.toHaveProperty('lastCallInputTokens');
  });

  it('orders the models by what they cost', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'x');
    sessions.get('s1')!.rpc.usage.getMetrics.mockResolvedValueOnce({
      totalPremiumRequestCost: 390,
      totalUserRequests: 0,
      totalApiDurationMs: 0,
      sessionStartTime: '2026-09-13T22:54:00.166Z',
      lastCallInputTokens: 0,
      lastCallOutputTokens: 0,
      codeChanges: { linesAdded: 0, linesRemoved: 0, filesModifiedCount: 0, filesModified: [] },
      modelMetrics: {
        cheap: { requests: { count: 2, cost: 10 }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
        dear: { requests: { count: 9, cost: 300 }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
      },
    } as never);

    expect((await runtime.usage('s1'))?.models?.map((m) => m.model)).toEqual(['dear', 'cheap']);
  });

  // The whole point: browsing what a session cost must not cost a Copilot process.
  it('reads a cold session from its log rather than resuming it', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.usage('never-opened');

    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('says nothing for a cold session whose log has no checkpoint', async () => {
    const { runtime } = makeRuntime();

    expect(await runtime.usage('never-opened')).toBeNull();
  });

  /**
   * The cold answer is the log's, not a blank. Without this a session nobody has opened
   * would report nothing at all, which is the state the checkpoint exists to avoid.
   */
  it('gives back what the log recorded for a session that is not loaded', async () => {
    const { runtime } = makeRuntime();
    lastUsage.mockResolvedValueOnce({ premiumRequests: 45, aiu: 2048.175675, loaded: false });

    expect(await runtime.usage('cold')).toEqual({ premiumRequests: 45, aiu: 2048.175675, loaded: false });
    expect(lastUsage).toHaveBeenCalledWith('cold');
  });

  it('does not read the log for a session it is already holding', async () => {
    const { runtime } = makeRuntime();
    await runtime.send('s1', 'x');
    lastUsage.mockClear();

    await runtime.usage('s1');

    expect(lastUsage).not.toHaveBeenCalled();
  });
});

/**
 * MCP servers a session here would be offered, discovered rather than asked of a session.
 *
 * Worth having in the environment panel rather than behind a running session: the CLI's own
 * /env lists them, and which servers a directory would load is a question about the machine
 * and its config rather than about any conversation (#24).
 */
describe('environment, MCP servers', () => {
  function withEnvironment(runtimeParts: ReturnType<typeof makeRuntime>) {
    const rpc = runtimeParts.client.rpc as unknown as Record<string, unknown>;
    rpc.instructions = { discover: vi.fn(async () => ({ sources: [] })) };
    rpc.extensions = { discover: vi.fn(async () => ({ extensions: [], mode: 'load_and_augment' })) };
    rpc.skills = { discover: vi.fn(async () => ({ skills: [], errors: [] })) };
    rpc.hooks = { discover: vi.fn(async () => ({ hooks: [], warnings: [], errors: [] })) };
    rpc.mcp = {
      discover: vi.fn(async (_params: { workingDirectory?: string }) => ({
        servers: [
          { name: 'context7', type: 'http', source: 'user', enabled: true },
          {
            name: 'from-a-plugin',
            type: 'stdio',
            source: 'plugin',
            sourcePlugin: 'awesome-copilot',
            sourcePluginVersion: '1.2.0',
            enabled: false,
          },
        ],
      })),
    };
    return rpc;
  }

  it('lists the servers there are, with what each is and where it came from', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    expect((await parts.runtime.discovery.environment('C:\\repo')).mcpServers).toEqual([
      { name: 'context7', type: 'http', source: 'user', enabled: true, editable: false },
      {
        name: 'from-a-plugin',
        type: 'stdio',
        source: 'plugin',
        sourcePlugin: 'awesome-copilot',
        enabled: false,
        editable: false,
      },
    ]);
  });

  /** A disabled server is still configured, and saying so is the point of listing it. */
  it('reports a server that is switched off rather than dropping it', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);

    const found = (await parts.runtime.discovery.environment()).mcpServers.find((s) => s.name === 'from-a-plugin');
    expect(found?.enabled).toBe(false);
  });

  /**
   * Discovery takes one directory, not the project paths its neighbours take. Passing the
   * wrong shape is quietly accepted and answers for nowhere in particular.
   */
  it('asks about the working directory it was given', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);
    await parts.runtime.discovery.environment('C:\\repo');

    expect((rpc.mcp as { discover: ReturnType<typeof vi.fn> }).discover).toHaveBeenCalledWith({
      workingDirectory: 'C:\\repo',
    });
  });

  it('asks about no directory at all when there is none', async () => {
    const parts = makeRuntime();
    const rpc = withEnvironment(parts);
    await parts.runtime.discovery.environment();

    expect((rpc.mcp as { discover: ReturnType<typeof vi.fn> }).discover).toHaveBeenCalledWith({});
  });

  it('resumes nothing to answer', async () => {
    const parts = makeRuntime();
    withEnvironment(parts);
    await parts.runtime.discovery.environment('C:\\repo');

    expect(parts.client.resumeSession).not.toHaveBeenCalled();
  });
});

/**
 * Turning a server off is the reader's own configuration rather than anything about a
 * conversation, so it costs no session on either side of the wire (#24).
 */
describe('switching an MCP server on and off', () => {
  function withMcpConfig(parts: ReturnType<typeof makeRuntime>) {
    const rpc = parts.client.rpc as unknown as Record<string, unknown>;
    rpc.mcp = {
      discover: vi.fn(async () => ({ servers: [] })),
      config: {
        list: vi.fn(async () => ({ servers: {} })),
        add: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        enable: vi.fn(async () => undefined),
        disable: vi.fn(async () => undefined),
      },
    };
    return rpc.mcp as { config: { enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> } };
  }

  it('disables by name', async () => {
    const parts = makeRuntime();
    const mcp = withMcpConfig(parts);

    await parts.runtime.discovery.setMcpEnabled('context7', false);

    expect(mcp.config.disable).toHaveBeenCalledWith({ names: ['context7'] });
    expect(mcp.config.enable).not.toHaveBeenCalled();
  });

  it('enables by name', async () => {
    const parts = makeRuntime();
    const mcp = withMcpConfig(parts);

    await parts.runtime.discovery.setMcpEnabled('context7', true);

    expect(mcp.config.enable).toHaveBeenCalledWith({ names: ['context7'] });
    expect(mcp.config.disable).not.toHaveBeenCalled();
  });

  it('resumes no session to do it', async () => {
    const parts = makeRuntime();
    withMcpConfig(parts);

    await parts.runtime.discovery.setMcpEnabled('context7', false);

    expect(parts.client.resumeSession).not.toHaveBeenCalled();
  });
});

/**
 * A session made through the SDK is named with its whole first prompt and keeps that name
 * forever - every one this app has ever made still has `summary_count: 0`, and one carried
 * 303 characters. The CLI does not have this problem because it writes a title itself (#197).
 */
describe('SessionRuntime writing a title for a new session', () => {
  const asked = (session: FakeSession) => session.rpc.ui.ephemeralQuery.mock.calls.length;
  const titleSet = (session: FakeSession) => session.rpc.name.setAuto.mock.calls[0]?.[0]?.summary;

  beforeEach(() => {
    nameState.mockReset();
    // The state a new session is in: named after the prompt, by nobody.
    nameState.mockImplementation(() => ({ name: 'the prompt', named: false }));
  });

  it('writes one for a session still wearing its prompt', async () => {
    const harness = makeRuntime();
    await sendAndFinish(harness, 's1', 'the prompt');
    await vi.waitFor(() => expect(titleSet(harness.sessions.get('s1')!)).toBe('A Written Title'));
  });

  it('asks the runtime own question, so the title reads like one the CLI wrote', async () => {
    const harness = makeRuntime();
    await sendAndFinish(harness, 's1', 'the prompt');

    await vi.waitFor(() => expect(asked(harness.sessions.get('s1')!)).toBe(1));
    const question = harness.sessions.get('s1')!.rpc.ui.ephemeralQuery.mock.calls[0]![0].question;
    expect(question).toContain('2-6 words, title case');
  });

  // Set as a name nobody chose, so a rename still outranks it and the runtime may still
  // replace it. Writing it as a chosen name would be claiming the reader asked for it.
  it('sets it as a name nobody chose', async () => {
    const harness = makeRuntime();
    await sendAndFinish(harness, 's1', 'the prompt');

    await vi.waitFor(() => expect(harness.sessions.get('s1')!.rpc.name.setAuto).toHaveBeenCalled());
    expect(harness.sessions.get('s1')!.rpc.name.set).not.toHaveBeenCalled();
  });

  it('tells the list to read the name again', async () => {
    const onChangesRecorded = vi.fn();
    const harness = makeRuntime({ onChangesRecorded });
    await sendAndFinish(harness, 's1', 'the prompt');

    // Once for the turn, once for the name.
    await vi.waitFor(() => expect(onChangesRecorded.mock.calls.length).toBeGreaterThan(1));
  });

  it('leaves a name somebody chose alone', async () => {
    nameState.mockImplementation(() => ({ name: 'A Name Somebody Chose', named: true }));
    const harness = makeRuntime();
    await sendAndFinish(harness, 's1', 'the prompt');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked(harness.sessions.get('s1')!)).toBe(0);
  });

  it('leaves a title the CLI already wrote alone', async () => {
    nameState.mockImplementation(() => ({ name: 'Investigate Arcana Navigation Bug', named: false }));
    const harness = makeRuntime();
    await sendAndFinish(harness, 's1', 'the prompt');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked(harness.sessions.get('s1')!)).toBe(0);
  });

  // Or every idle for the rest of the sitting would spend a model call. The same prompt
  // throughout, so the only thing that can stop the second and third asking is the guard:
  // a different prompt would stop them by looking unlike the name, proving nothing.
  it('asks once per session, however many turns it takes', async () => {
    const harness = makeRuntime();
    await sendAndFinish(harness, 's1', 'the prompt');
    await vi.waitFor(() => expect(asked(harness.sessions.get('s1')!)).toBe(1));

    await sendAndFinish(harness, 's1', 'the prompt');
    await sendAndFinish(harness, 's1', 'the prompt');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked(harness.sessions.get('s1')!)).toBe(1);
  });

  it('keeps the name it had when the model answers with something that is not a title', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'the prompt');
    harness.sessions.get('s1')!.rpc.ui.ephemeralQuery.mockResolvedValueOnce({ answer: 'I think it is about logins.' });

    harness.sessions.get('s1')!.emit({ type: 'session.idle', data: {} });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.sessions.get('s1')!.rpc.name.setAuto).not.toHaveBeenCalled();
  });

  /**
   * `auto` is the default and cannot answer the question - the inference comes back as "the
   * requested model is not supported" - so the session is moved to one that can. Safe only
   * because it is idle: the same mid-turn would run part of somebody's turn on a model they
   * did not choose.
   */
  it('moves the session to a model that can answer when its own cannot', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'the prompt');
    const session = harness.sessions.get('s1')!;
    session.rpc.ui.ephemeralQuery.mockRejectedValueOnce(new Error('the requested model is not supported'));

    session.emit({ type: 'session.idle', data: {} });

    await vi.waitFor(() => expect(session.rpc.name.setAuto).toHaveBeenCalled());
    // The cheapest named one it was offered, never `auto`, which is what could not answer.
    expect(session.setModel.mock.calls[0]?.[0]).toBe('a-haiku-model');
  });

  // `auto` is the one model that cannot answer, so it is never the one moved to - not even
  // when nothing on offer looks cheap and the choice falls back to whatever is first.
  it('never moves to auto, whatever the list looks like', async () => {
    const harness = makeRuntime();
    harness.client.listModels.mockResolvedValue([{ id: 'auto' }, { id: 'some-model' }]);
    await harness.runtime.send('s1', 'the prompt');
    const session = harness.sessions.get('s1')!;
    session.rpc.ui.ephemeralQuery.mockRejectedValueOnce(new Error('the requested model is not supported'));

    session.emit({ type: 'session.idle', data: {} });

    await vi.waitFor(() => expect(session.setModel).toHaveBeenCalled());
    expect(session.setModel.mock.calls[0]?.[0]).toBe('some-model');
  });

  // Being left on a model nobody chose is worse than having no title.
  it('puts the model back afterwards', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'the prompt');
    const session = harness.sessions.get('s1')!;
    session.rpc.ui.ephemeralQuery.mockRejectedValueOnce(new Error('the requested model is not supported'));

    session.emit({ type: 'session.idle', data: {} });

    await vi.waitFor(() => expect(session.rpc.name.setAuto).toHaveBeenCalled());
    expect(session.setModel.mock.calls.at(-1)?.[0]).toBe('a-named-model');
  });

  it('puts the model back even when the second question fails too', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'the prompt');
    const session = harness.sessions.get('s1')!;
    session.rpc.ui.ephemeralQuery.mockRejectedValue(new Error('the requested model is not supported'));

    session.emit({ type: 'session.idle', data: {} });

    await vi.waitFor(() => expect(session.setModel.mock.calls.length).toBe(2));
    expect(session.setModel.mock.calls.at(-1)?.[0]).toBe('a-named-model');
    expect(session.rpc.name.setAuto).not.toHaveBeenCalled();
  });
  it('keeps the name it had when the question cannot be answered at all', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'the prompt');
    const session = harness.sessions.get('s1')!;
    session.rpc.ui.ephemeralQuery.mockRejectedValue(new Error('the requested model is not supported'));

    session.emit({ type: 'session.idle', data: {} });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.rpc.name.setAuto).not.toHaveBeenCalled();
  });
});

/**
 * #100 asks what should happen to a setting that changes something already running. The
 * answer is that it takes effect on what is running: a reader lowering the cap because
 * their machine is struggling means now, not next time.
 */
describe('SessionRuntime being told what may stay in memory', () => {
  const loadedCount = (sessions: Map<string, FakeSession>) =>
    [...sessions.values()].filter((session) => !session.disconnected).length;

  it('releases what is over a cap that has just been lowered', async () => {
    const harness = makeRuntime();
    for (const id of ['s1', 's2', 's3']) await sendAndFinish(harness, id);
    expect(loadedCount(harness.sessions)).toBe(3);

    await harness.runtime.setLimits({ maxLoadedSessions: 1, idleTimeoutMs: 0 });

    expect(loadedCount(harness.sessions)).toBe(1);
    // The most recently used is the one kept.
    expect(harness.sessions.get('s3')!.disconnected).toBe(false);
  });

  // The cap is about memory, and interrupting work to save some is a trade nobody asked for.
  it('never releases one that is mid-turn, whatever the cap says', async () => {
    const harness = makeRuntime();
    await sendAndFinish(harness, 's1');
    await harness.runtime.send('s2', 'still working');

    await harness.runtime.setLimits({ maxLoadedSessions: 1, idleTimeoutMs: 0 });

    expect(harness.sessions.get('s2')!.disconnected).toBe(false);
  });

  it('keeps everything when the cap is lifted', async () => {
    const harness = makeRuntime({ maxLoadedSessions: 1 });
    for (const id of ['s1', 's2']) await sendAndFinish(harness, id);
    expect(loadedCount(harness.sessions)).toBe(1);

    await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0 });
    for (const id of ['s3', 's4']) await sendAndFinish(harness, id);

    expect(loadedCount(harness.sessions)).toBe(3);
  });

  it('reports the cap it was given', async () => {
    const harness = makeRuntime();

    await harness.runtime.setLimits({ maxLoadedSessions: 4, idleTimeoutMs: 0 });

    expect(harness.runtime.status().maxLoadedSessions).toBe(4);
  });

  /**
   * Restarted rather than left alone: a countdown already running is counting to the old
   * length, so a reader who shortened it would have to wait out the old one first.
   */
  it('restarts the countdowns against the new length', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeRuntime({ idleTimeoutMs: 60_000 });
      await sendAndFinish(harness, 's1');
      vi.advanceTimersByTime(55_000);

      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 10_000 });

      // The old countdown would have fired here; the new one has only run five seconds.
      vi.advanceTimersByTime(6_000);
      expect(harness.sessions.get('s1')!.disconnected).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.sessions.get('s1')!.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops releasing idle sessions when the countdown is turned off', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeRuntime({ idleTimeoutMs: 10_000 });
      await sendAndFinish(harness, 's1');

      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(harness.sessions.get('s1')!.disconnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a negative cap', { maxLoadedSessions: -2, idleTimeoutMs: 1_000 }, 0],
    ['a fractional cap', { maxLoadedSessions: 2.7, idleTimeoutMs: 1_000 }, 2],
  ])('makes sense of %s', async (_what, limits, expected) => {
    const harness = makeRuntime();

    await harness.runtime.setLimits(limits);

    expect(harness.runtime.status().maxLoadedSessions).toBe(expected);
  });
});


/**
 * The permission mode belongs to the session, not to the process. Giving the shared CLI
 * `--allow-all` or `--yolo` leaves every session it creates asking - tested against a real
 * runtime, and they come back `manual` either way (#199).
 */
describe('SessionRuntime starting a session as it was asked to', () => {
  const madeSession = (sessions: Map<string, FakeSession>) => sessions.get('made')!;

  it('leaves a new session asking, which is what the CLI does', async () => {
    const harness = makeRuntime();

    await harness.runtime.create();

    expect(madeSession(harness.sessions).rpc.permissions.setMode).not.toHaveBeenCalled();
  });

  it('puts it in allow-all when that was asked for', async () => {
    const harness = makeRuntime();

    await harness.runtime.create(undefined, { allowAll: true });

    expect(madeSession(harness.sessions).rpc.permissions.setMode).toHaveBeenCalledExactlyOnceWith({
      mode: 'allow-all',
    });
  });

  it('leaves it asking when that was asked for, rather than saying so twice', async () => {
    const harness = makeRuntime();

    await harness.runtime.create(undefined, { allowAll: false });

    expect(madeSession(harness.sessions).rpc.permissions.setMode).not.toHaveBeenCalled();
  });

  /**
   * The mode does not survive a session being released, so it has to be set every time one
   * is opened rather than once when it is made. Without this the setting only ever reached
   * sessions this app had just created, and an older one went on asking (#199).
   */
  describe('a session that was resumed rather than made', () => {
    it('runs tools without asking when that is the setting', async () => {
      const harness = makeRuntime();
      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: true });

      await harness.runtime.load('a');

      expect(harness.sessions.get('a')?.rpc.permissions.setMode).toHaveBeenCalledExactlyOnceWith({
        mode: 'allow-all',
      });
    });

    /**
     * Told to ask, rather than left alone. The mode is kept with the session and survives
     * being released, so one that was ever permissive stays permissive unless it is told
     * otherwise - which is how turning the setting off came to do nothing at all.
     */
    it('is put back to asking when that is the setting', async () => {
      const harness = makeRuntime();
      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: false });

      await harness.runtime.load('a');

      expect(harness.sessions.get('a')?.rpc.permissions.setMode).toHaveBeenCalledWith({ mode: 'manual' });
    });

    // Nothing has been said about it, so the session is told to ask - which is where one
    // starts, and the safe answer for one that may have been told otherwise before.
    it('is put back to asking when the setting has never been given', async () => {
      const harness = makeRuntime();

      await harness.runtime.load('a');

      expect(harness.sessions.get('a')?.rpc.permissions.setMode).toHaveBeenCalledWith({ mode: 'manual' });
    });

    // Opening the session matters more than the mode taking.
    it('still opens when the mode cannot be set', async () => {
      const harness = makeRuntime();
      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: true });
      harness.sessions.get('a')?.rpc.permissions.setMode.mockRejectedValue(new Error('no such mode'));

      await harness.runtime.load('a');

      expect(harness.runtime.isActive('a')).toBe(true);
    });

    /**
     * The limits are sent together whenever any of them changes, and this one is optional.
     * A caller that says nothing about it has not changed it, so the answer already given
     * stands - in either direction.
     */
    it('keeps running without asking when a later change says nothing about it', async () => {
      const harness = makeRuntime();
      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: true });
      await harness.runtime.setLimits({ maxLoadedSessions: 3, idleTimeoutMs: 0 });

      await harness.runtime.load('a');

      expect(harness.sessions.get('a')?.rpc.permissions.setMode).toHaveBeenCalledExactlyOnceWith({
        mode: 'allow-all',
      });
    });

    /**
     * The bug this was written for: the mode is kept with the session, so one told once to
     * allow everything comes back allowing everything. Only ever saying `allow-all` meant
     * turning the setting off reached a session while it was open and never again.
     */
    it('puts a session that was once permissive back to asking', async () => {
      const harness = makeRuntime();
      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: true });
      await harness.runtime.load('a');
      await harness.runtime.evict('a');

      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: false });
      await harness.runtime.load('a');

      expect(harness.sessions.get('a')?.rpc.permissions.setMode).toHaveBeenLastCalledWith({
        mode: 'manual',
      });
    });
  });

  /**
   * Turning it on is a statement about the session being used now, not only about the one
   * after it. Waiting for a session to be released and reopened would make the setting
   * look like it had done nothing.
   */
  describe('changing it while a session is open', () => {
    it('stops the open session asking', async () => {
      const harness = makeRuntime();
      await harness.runtime.load('a');

      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: true });

      expect(harness.sessions.get('a')?.rpc.permissions.setMode).toHaveBeenLastCalledWith({
        mode: 'allow-all',
      });
    });

    // A session already told to allow everything has to be told to stop.
    it('sets the open session back to asking when it is turned off', async () => {
      const harness = makeRuntime();
      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: true });
      await harness.runtime.load('a');

      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: false });

      expect(harness.sessions.get('a')?.rpc.permissions.setMode).toHaveBeenLastCalledWith({
        mode: 'manual',
      });
    });

    // Nothing changed, so there is nothing to tell anybody beyond what opening it said.
    it('says nothing further to an open session when the answer is the same', async () => {
      const harness = makeRuntime();
      await harness.runtime.load('a');
      const said = harness.sessions.get('a')!.rpc.permissions.setMode.mock.calls.length;

      await harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: false });

      expect(harness.sessions.get('a')?.rpc.permissions.setMode.mock.calls.length).toBe(said);
    });

    it('still applies the change when one session refuses it', async () => {
      const harness = makeRuntime();
      await harness.runtime.load('a');
      harness.sessions.get('a')?.rpc.permissions.setMode.mockRejectedValue(new Error('no such mode'));

      await expect(
        harness.runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, allowAll: true }),
      ).resolves.toBeUndefined();
    });
  });

  // A session that asks when it was meant not to is an annoyance; the reverse is not.
  it('still makes the session when the mode cannot be set', async () => {
    const harness = makeRuntime();
    harness.client.createSession.mockImplementationOnce(async () => {
      const session = { ...makeSession('made'), sessionId: 'made' };
      session.rpc.permissions.setMode.mockRejectedValue(new Error('no such mode'));
      harness.sessions.set('made', session);
      return session;
    });

    const { sessionId } = await harness.runtime.create(undefined, { allowAll: true });

    expect(sessionId).toBe('made');
    expect(harness.runtime.isActive('made')).toBe(true);
  });

  it('starts it where it was told to', async () => {
    const harness = makeRuntime();

    await harness.runtime.create('F:\\work');

    expect(harness.client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: 'F:\\work' }),
    );
  });

  /**
   * Given at creation rather than set afterwards, unlike the permission mode: the model is
   * a field the runtime's own session config already takes (#200).
   */
  it('starts it on the model it was given', async () => {
    const harness = makeRuntime();

    await harness.runtime.create(undefined, { model: 'gpt-5.5' });

    expect(harness.client.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.5' }));
  });

  it('starts it thinking as hard, and with as much room, as it was told', async () => {
    const harness = makeRuntime();

    await harness.runtime.create(undefined, {
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      contextTier: 'long_context',
    });

    expect(harness.client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.5', reasoningEffort: 'high', contextTier: 'long_context' }),
    );
  });

  /** Applied to whatever the runtime chose instead, they would answer a question nobody asked. */
  it('says nothing about either without a model to apply them to', async () => {
    const harness = makeRuntime();

    await harness.runtime.create(undefined, { reasoningEffort: 'high', contextTier: 'long_context' });

    const config = harness.client.createSession.mock.calls[0]![0];
    expect(config).not.toHaveProperty('reasoningEffort');
    expect(config).not.toHaveProperty('contextTier');
  });

  // Absent leaves the runtime's own choice, which is what an empty setting means.
  it('says nothing about the model when none was named', async () => {
    const harness = makeRuntime();

    await harness.runtime.create();

    expect(harness.client.createSession.mock.calls[0]![0]).not.toHaveProperty('model');
  });

  it('says nothing about it for an empty name either', async () => {
    const harness = makeRuntime();

    await harness.runtime.create(undefined, { model: '' });

    expect(harness.client.createSession.mock.calls[0]![0]).not.toHaveProperty('model');
  });
});

/**
 * How long a question to the reader waits before it answers itself. One number for all four
 * kinds, and read afresh for each new question so a change of setting reaches the next one
 * asked rather than the next sidecar (#201).
 */
describe('how long a question waits', () => {
  const askAbout = async (runtime: SessionRuntime, handlers: Map<string, (r: unknown) => unknown>) => {
    await runtime.send('a', 'x');
    return handlers.get('a')!({ kind: 'shell' });
  };

  it('gives up after the wait it was told to use', async () => {
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest: vi.fn(), permissionTimeoutMs: 5 });

    await expect(askAbout(runtime, permissionHandlers)).resolves.toEqual({ kind: 'user-not-available' });
  });

  it('says when a question lapses, so the prompt can count down to it', async () => {
    const onPermissionRequest = vi.fn();
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest, permissionTimeoutMs: 60_000 });

    void askAbout(runtime, permissionHandlers);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The fifth is the directory worth offering, absent for a request that names no path;
    // the sixth is the subagent that asked, absent where the session asked for itself.
    expect(onPermissionRequest).toHaveBeenCalledWith(
      'a',
      expect.any(String),
      expect.anything(),
      expect.any(String),
      undefined,
      undefined,
    );
  });

  describe('with no wait at all', () => {
    it('leaves the question standing rather than answering it', async () => {
      const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest: vi.fn(), permissionTimeoutMs: 0 });
      let settled = false;

      void askAbout(runtime, permissionHandlers).then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(settled).toBe(false);
    });

    /** There is no deadline, so a countdown would be counting to nothing. */
    it('offers the prompt no deadline to show', async () => {
      const onPermissionRequest = vi.fn();
      const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest, permissionTimeoutMs: 0 });

      void askAbout(runtime, permissionHandlers);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onPermissionRequest).toHaveBeenCalledWith(
        'a',
        expect.any(String),
        expect.anything(),
        null,
        undefined,
        undefined,
      );
    });
  });

  // Told as a rule like the memory limits, and reaching a question asked after it is set.
  it('takes a new wait for the next question asked', async () => {
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest: vi.fn(), permissionTimeoutMs: 60_000 });
    await runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0, permissionTimeoutMs: 5 });

    await expect(askAbout(runtime, permissionHandlers)).resolves.toEqual({ kind: 'user-not-available' });
  });

  /** Rules that say nothing about it should not quietly turn the wait off. */
  it('keeps the wait it had when it is not given one', async () => {
    const { runtime, permissionHandlers } = makeRuntime({ onPermissionRequest: vi.fn(), permissionTimeoutMs: 5 });
    await runtime.setLimits({ maxLoadedSessions: 0, idleTimeoutMs: 0 });

    // Still gives up, so the five milliseconds survived rules that said nothing about it.
    await expect(askAbout(runtime, permissionHandlers)).resolves.toEqual({ kind: 'user-not-available' });
  });
});

/**
 * Custom agents and hooks, which the CLI's own /env lists and this panel did not (#165).
 *
 * Both are discovered from the server rather than from a session, so the panel still answers
 * for a directory nothing has ever run in - which is the whole reason /env was taken over.
 */
describe('environment, agents and hooks', () => {
  function withEnvironment(parts: ReturnType<typeof makeRuntime>) {
    const rpc = parts.client.rpc as unknown as Record<string, unknown>;
    rpc.instructions = { discover: vi.fn(async () => ({ sources: [] })) };
    rpc.extensions = { discover: vi.fn(async () => ({ extensions: [], mode: 'load_and_augment' })) };
    rpc.skills = { discover: vi.fn(async () => ({ skills: [], errors: [] })) };
    rpc.mcp = { discover: vi.fn(async () => ({ servers: [] })), config: { list: vi.fn(async () => ({ servers: {} })) } };
    return parts;
  }

  const hook = (over: Record<string, unknown> = {}) => ({
    id: 'hook:abc',
    hookType: 'preToolUse',
    origin: 'user',
    enabled: true,
    source: 'C:\\Users\\x\\.copilot\\hooks\\sounds.json',
    ...over,
  });

  it('lists the agents a session here could run as', async () => {
    const { runtime } = withEnvironment(makeRuntime());

    const found = await runtime.discovery.environment('C:\\repo');

    expect(found.agents.map((agent) => agent.name)).toEqual(['deep-audit', 'spawned-only']);
  });

  /** The same reader the picker uses, so the two cannot come to disagree about an agent. */
  it('reads them through the same discovery the picker uses', async () => {
    const parts = withEnvironment(makeRuntime());

    await parts.runtime.discovery.environment('C:\\repo');

    const discover = (parts.client.rpc.agents as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({ projectPaths: ['C:\\repo'] });
  });

  it('lists the hooks that would fire', async () => {
    const parts = withEnvironment(makeRuntime());
    (parts.client.rpc as unknown as Record<string, unknown>).hooks = {
      discover: vi.fn(async () => ({
        hooks: [hook(), hook({ id: 'hook:def', hookType: 'agentStop', enabled: false })],
        warnings: [],
        errors: [],
      })),
    };

    const found = await parts.runtime.discovery.environment('C:\\repo');

    expect(found.hooks).toEqual([
      {
        id: 'hook:abc',
        event: 'preToolUse',
        origin: 'user',
        source: 'C:\\Users\\x\\.copilot\\hooks\\sounds.json',
        enabled: true,
      },
      {
        id: 'hook:def',
        event: 'agentStop',
        origin: 'user',
        source: 'C:\\Users\\x\\.copilot\\hooks\\sounds.json',
        enabled: false,
      },
    ]);
  });

  it('looks for hooks in the working directory', async () => {
    const parts = withEnvironment(makeRuntime());

    await parts.runtime.discovery.environment('C:\\repo');

    const discover = (parts.client.rpc.hooks as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({ projectPaths: ['C:\\repo'] });
  });

  it('asks about no project at all when there is no working directory', async () => {
    const parts = withEnvironment(makeRuntime());

    await parts.runtime.discovery.environment();

    const discover = (parts.client.rpc.hooks as { discover: ReturnType<typeof vi.fn> }).discover;
    expect(discover).toHaveBeenCalledWith({});
  });

  it('leaves out a source the runtime did not attribute', async () => {
    const parts = withEnvironment(makeRuntime());
    (parts.client.rpc as unknown as Record<string, unknown>).hooks = {
      discover: vi.fn(async () => ({ hooks: [hook({ source: undefined })], warnings: [], errors: [] })),
    };

    const found = await parts.runtime.discovery.environment('C:\\repo');

    expect(found.hooks[0]).not.toHaveProperty('source');
  });

  /**
   * A hook whose source failed to load is simply absent, which reads as never having been
   * written. Both kinds of complaint are passed on, since either can mean a hook that will
   * not fire.
   */
  it('passes on what could not be loaded, warnings as well as errors', async () => {
    const parts = withEnvironment(makeRuntime());
    (parts.client.rpc as unknown as Record<string, unknown>).hooks = {
      discover: vi.fn(async () => ({ hooks: [], warnings: ['a warning'], errors: ['an error'] })),
    };

    const found = await parts.runtime.discovery.environment('C:\\repo');

    expect(found.hookErrors).toEqual(['an error', 'a warning']);
  });

  it('treats absent complaints as none', async () => {
    const parts = withEnvironment(makeRuntime());
    (parts.client.rpc as unknown as Record<string, unknown>).hooks = {
      discover: vi.fn(async () => ({ hooks: [] })),
    };

    const found = await parts.runtime.discovery.environment('C:\\repo');

    expect(found.hookErrors).toEqual([]);
  });

  // The panel exists to answer without one, so neither of these may reach for a session.
  it('resumes nothing to answer', async () => {
    const parts = withEnvironment(makeRuntime());

    await parts.runtime.discovery.environment('C:\\repo');

    expect(parts.client.resumeSession).not.toHaveBeenCalled();
    expect(parts.client.createSession).not.toHaveBeenCalled();
  });
});
/**
 * The plugin directories are cached against the client that answered for them, so stopping
 * the server has to drop them. A second run could be a different CLI with different plugins
 * installed, and a stale list would send a session looking for skills that are not there.
 *
 * The cache moved out with the rest of discovery (#183); this is the one thread between the
 * two that is not just a call.
 */
describe('what a shutdown forgets', () => {
  const dir = (name: string) => join(copilotHome, 'installed-plugins', 'awesome-copilot', name);

  it('reads the plugins once while the server stays up', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.create('C:\\repo');
    await runtime.create('C:\\repo');

    expect(client.rpc.plugins.list).toHaveBeenCalledOnce();
  });

  it('reads them again after the server has stopped', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.create('C:\\repo');
    await runtime.shutdown();

    await runtime.create('C:\\repo');

    expect(client.rpc.plugins.list).toHaveBeenCalledTimes(2);
  });

  it('gives the new session what the new server reported', async () => {
    const { runtime, client } = makeRuntime();
    await runtime.create('C:\\repo');
    await runtime.shutdown();

    client.rpc.plugins.list.mockResolvedValue({
      plugins: [{ name: 'installed-since', marketplace: 'awesome-copilot', enabled: true }],
    });
    await runtime.create('C:\\repo');

    expect(client.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ pluginDirectories: [dir('installed-since')] }),
    );
  });
});
/**
 * Adding, editing and removing an MCP server, which the panel could not do (#24).
 *
 * All of it sessionless: the config is the reader's own file rather than anything a
 * conversation holds, which is what lets it sit beside a list that is free to read. The
 * session-scoped half of that issue - live connection status, OAuth - is not this.
 */
describe('writing the MCP config', () => {
  function withConfig(parts: ReturnType<typeof makeRuntime>, servers: Record<string, unknown> = {}) {
    const rpc = parts.client.rpc as unknown as Record<string, unknown>;
    const config = {
      list: vi.fn(async () => ({ servers })),
      add: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      enable: vi.fn(async () => undefined),
      disable: vi.fn(async () => undefined),
    };
    rpc.mcp = { discover: vi.fn(async () => ({ servers: [] })), config };
    return config;
  }

  it('adds a server that was not there', async () => {
    const parts = makeRuntime();
    const config = withConfig(parts);

    await parts.runtime.discovery.saveMcpServer('c7', { transport: 'http', url: 'https://c7/mcp' });

    expect(config.add).toHaveBeenCalledWith({
      name: 'c7',
      config: { type: 'http', url: 'https://c7/mcp', command: undefined, args: undefined },
    });
    expect(config.update).not.toHaveBeenCalled();
  });

  /** One call here and two in the runtime: a reader saving a form is not aware of the difference. */
  it('updates one that was', async () => {
    const parts = makeRuntime();
    const config = withConfig(parts, { c7: { type: 'http', url: 'https://old/mcp' } });

    await parts.runtime.discovery.saveMcpServer('c7', { transport: 'http', url: 'https://new/mcp' });

    expect(config.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'c7' }));
    expect(config.add).not.toHaveBeenCalled();
  });

  it('writes a command server as a command', async () => {
    const parts = makeRuntime();
    const config = withConfig(parts);

    await parts.runtime.discovery.saveMcpServer('local', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
    });

    expect(config.add).toHaveBeenCalledWith({
      name: 'local',
      config: { type: 'local', command: 'npx', args: ['-y', 'pkg'], url: undefined },
    });
  });

  /**
   * The config carries filters, timeouts and telemetry policy that this app has no controls
   * for. Saving a server must not quietly throw those away.
   */
  it('keeps the settings it has no controls for', async () => {
    const parts = makeRuntime();
    const config = withConfig(parts, { c7: { type: 'http', url: 'https://old/mcp', tools: ['a'], timeout: 9000 } });

    await parts.runtime.discovery.saveMcpServer('c7', { transport: 'http', url: 'https://new/mcp' });

    expect(config.update).toHaveBeenCalledWith({
      name: 'c7',
      config: expect.objectContaining({ tools: ['a'], timeout: 9000, url: 'https://new/mcp' }),
    });
  });

  /** Switching transport has to clear the other one, or the runtime sees both. */
  it('clears the url when a server becomes a command', async () => {
    const parts = makeRuntime();
    const config = withConfig(parts, { c7: { type: 'http', url: 'https://old/mcp' } });

    await parts.runtime.discovery.saveMcpServer('c7', { transport: 'stdio', command: 'npx' });

    expect(config.update).toHaveBeenCalledWith({
      name: 'c7',
      config: expect.objectContaining({ command: 'npx', url: undefined }),
    });
  });

  it('removes one by name', async () => {
    const parts = makeRuntime();
    const config = withConfig(parts, { c7: {} });

    await parts.runtime.discovery.removeMcpServer('c7');

    expect(config.remove).toHaveBeenCalledWith({ name: 'c7' });
  });

  it('resumes nothing to do any of it', async () => {
    const parts = makeRuntime();
    withConfig(parts);

    await parts.runtime.discovery.saveMcpServer('c7', { transport: 'http', url: 'https://c7/mcp' });
    await parts.runtime.discovery.removeMcpServer('c7');

    expect(parts.client.resumeSession).not.toHaveBeenCalled();
    expect(parts.client.createSession).not.toHaveBeenCalled();
  });
});

/**
 * What a server is, which the list could not say before: only the reader's own config
 * records the url or the command, and only servers in it can be changed from here.
 */
describe('what the MCP list says about each server', () => {
  function withServers(
    parts: ReturnType<typeof makeRuntime>,
    discovered: Record<string, unknown>[],
    servers: Record<string, unknown>,
  ) {
    const rpc = parts.client.rpc as unknown as Record<string, unknown>;
    rpc.mcp = {
      discover: vi.fn(async () => ({ servers: discovered })),
      config: { list: vi.fn(async () => ({ servers })) },
    };
  }

  it('says what an http server is reached at', async () => {
    const parts = makeRuntime();
    withServers(parts, [{ name: 'c7', type: 'http', source: 'user', enabled: true }], {
      c7: { type: 'http', url: 'https://c7/mcp' },
    });

    const [found] = await parts.runtime.discovery.mcpServers();

    expect(found).toMatchObject({ url: 'https://c7/mcp', editable: true });
  });

  it('says what a command server runs', async () => {
    const parts = makeRuntime();
    withServers(parts, [{ name: 'local', type: 'stdio', source: 'user', enabled: true }], {
      local: { command: 'npx', args: ['-y', 'pkg'] },
    });

    const [found] = await parts.runtime.discovery.mcpServers();

    expect(found).toMatchObject({ command: 'npx', args: ['-y', 'pkg'] });
  });

  /** Editing one here would write a copy into the reader's file rather than change the plugin. */
  it('will not offer to edit a server a plugin brought', async () => {
    const parts = makeRuntime();
    withServers(
      parts,
      [{ name: 'theirs', type: 'stdio', source: 'plugin', sourcePlugin: 'awesome-copilot', enabled: true }],
      { theirs: { command: 'npx' } },
    );

    const [found] = await parts.runtime.discovery.mcpServers();

    expect(found?.editable).toBe(false);
  });

  it('will not offer to edit one the config does not mention', async () => {
    const parts = makeRuntime();
    withServers(parts, [{ name: 'built-in', type: 'http', source: 'builtin', enabled: true }], {});

    const [found] = await parts.runtime.discovery.mcpServers();

    expect(found?.editable).toBe(false);
  });

  /** The servers still run and can still be switched off; they just cannot be edited. */
  it('still lists them when the config cannot be read at all', async () => {
    const parts = makeRuntime();
    const rpc = parts.client.rpc as unknown as Record<string, unknown>;
    rpc.mcp = {
      discover: vi.fn(async () => ({ servers: [{ name: 'c7', type: 'http', source: 'user', enabled: true }] })),
      config: { list: vi.fn(async () => { throw new Error('no config'); }) },
    };

    const found = await parts.runtime.discovery.mcpServers();

    expect(found).toEqual([{ name: 'c7', type: 'http', source: 'user', enabled: true, editable: false }]);
  });
});
/**
 * What an MCP server is actually doing, which only a loaded session can say (#24).
 *
 * The rule this follows is the one `usage` follows: a loaded session is asked, a cold one
 * answers nothing, and neither is ever resumed. Connection state is something a reader
 * would like to see rather than something they asked for.
 */
describe('what a session says its MCP servers are doing', () => {
  const listing = (servers: unknown[]) => vi.fn(async () => ({ servers }));

  it('says nothing at all for a session that is not loaded', async () => {
    const { runtime } = makeRuntime();

    expect(await runtime.mcpStatus('cold')).toBeNull();
  });

  it('resumes nothing to find out', async () => {
    const { runtime, client } = makeRuntime();

    await runtime.mcpStatus('cold');

    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('reports what a loaded session found', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'hello');
    const session = harness.sessions.get('s1')!;
    (session.rpc as unknown as Record<string, unknown>).mcp = {
      list: listing([
        { name: 'context7', status: 'connected' },
        { name: 'broken', status: 'failed', error: 'no such command' },
      ]),
    };

    expect(await harness.runtime.mcpStatus('s1')).toEqual([
      { name: 'context7', status: 'connected' },
      { name: 'broken', status: 'failed', error: 'no such command' },
    ]);
  });

  it('leaves out a reason where there was none', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'hello');
    const session = harness.sessions.get('s1')!;
    (session.rpc as unknown as Record<string, unknown>).mcp = {
      list: listing([{ name: 'context7', status: 'pending' }]),
    };

    expect((await harness.runtime.mcpStatus('s1'))?.[0]).not.toHaveProperty('error');
  });
});

/**
 * Signing in to a server that is waiting for it. Unlike reading the status, this may resume:
 * pressing a button is somebody asking, which is what the rule allows a resume for.
 */
describe('signing in to an MCP server', () => {
  it('hands back the page to send the reader to', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'hello');
    const session = harness.sessions.get('s1')!;
    (session.rpc as unknown as Record<string, unknown>).mcp = {
      oauth: { login: vi.fn(async () => ({ serverName: 'c7', authorizationUrl: 'https://auth/x' })) },
    };

    expect(await harness.runtime.mcpLogin('s1', 'c7')).toBe('https://auth/x');
  });

  it('says nothing rather than inventing a page when the runtime offered none', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'hello');
    const session = harness.sessions.get('s1')!;
    (session.rpc as unknown as Record<string, unknown>).mcp = {
      oauth: { login: vi.fn(async () => ({ serverName: 'c7' })) },
    };

    expect(await harness.runtime.mcpLogin('s1', 'c7')).toBeNull();
  });

  it('names the server it is signing in to', async () => {
    const harness = makeRuntime();
    await harness.runtime.send('s1', 'hello');
    const session = harness.sessions.get('s1')!;
    const login = vi.fn(async () => ({ serverName: 'c7', authorizationUrl: 'https://auth/x' }));
    (session.rpc as unknown as Record<string, unknown>).mcp = { oauth: { login } };

    await harness.runtime.mcpLogin('s1', 'c7');

    expect(login).toHaveBeenCalledWith({ serverName: 'c7' });
  });

  /** The one MCP call that may start a session, because the reader asked for it. */
  it('resumes a cold session to do it', async () => {
    const harness = makeRuntime();

    await harness.runtime.mcpLogin('cold', 'c7').catch(() => undefined);

    expect(harness.client.resumeSession).toHaveBeenCalled();
  });
});
/**
 * Putting a session back to an earlier turn (#156).
 *
 * The runtime answers all three of these from the live session, so each opens one - unlike
 * the change list beside them, which reads the snapshots on disk.
 */
describe('rewinding a session', () => {
  const pointsOf = (harness: ReturnType<typeof makeRuntime>) =>
    harness.sessions.get('a')!.rpc.history.listRewindPoints;

  it('opens the session to answer, since the runtime reads it from there', async () => {
    const harness = makeRuntime();

    await harness.runtime.rewindPoints('a');

    expect(harness.client.resumeSession).toHaveBeenCalled();
  });

  it('gives back the turns, named by what was asked', async () => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    pointsOf(harness).mockResolvedValue({
      fileChangeTrackingEnabled: true,
      points: [
        {
          eventId: 'e1',
          userMessage: 'change two things',
          timestamp: '2026-09-27T10:00:00.000Z',
          canRestoreFiles: true,
          fileCount: 2,
          turnChangedFiles: true,
          linesAdded: 9,
          linesRemoved: 3,
        },
      ],
    });

    const { points, unavailable } = await harness.runtime.rewindPoints('a');

    expect(unavailable).toBeUndefined();
    expect(points).toEqual([
      {
        eventId: 'e1',
        message: 'change two things',
        at: '2026-09-27T10:00:00.000Z',
        canRestoreFiles: true,
        fileCount: 2,
        linesAdded: 9,
        linesRemoved: 3,
      },
    ]);
  });

  // A prompt written into a terminal can carry escapes, and they are not part of what was said.
  it('strips the escapes out of what was asked', async () => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    pointsOf(harness).mockResolvedValue({
      fileChangeTrackingEnabled: true,
      points: [
        {
          eventId: 'e1',
          userMessage: 'make it \u001B[31mred\u001B[0m',
          timestamp: '2026-09-27T10:00:00.000Z',
          canRestoreFiles: true,
          fileCount: 0,
          turnChangedFiles: false,
          linesAdded: 0,
          linesRemoved: 0,
        },
      ],
    });

    const { points } = await harness.runtime.rewindPoints('a');

    expect(points[0]?.message).toBe('make it red');
  });

  /**
   * A prompt can carry a pasted document, and the menu draws one line of it. Sending the
   * rest would read it off disk, push it through a socket and parse it to throw it away -
   * once per turn, to write a list of rows.
   */
  describe('what a point says was asked', () => {
    const asking = async (userMessage: string) => {
      const harness = makeRuntime();
      await harness.runtime.load('a');
      pointsOf(harness).mockResolvedValue({
        fileChangeTrackingEnabled: true,
        points: [
          {
            eventId: 'e1',
            userMessage,
            timestamp: '2026-09-27T10:00:00.000Z',
            canRestoreFiles: true,
            fileCount: 0,
            turnChangedFiles: false,
            linesAdded: 0,
            linesRemoved: 0,
          },
        ],
      });

      return (await harness.runtime.rewindPoints('a')).points[0]?.message ?? '';
    };

    it('sends a short prompt whole', async () => {
      expect(await asking('count to twenty')).toBe('count to twenty');
    });

    it('sends the opening line rather than the rest of the prompt', async () => {
      expect(await asking('fix the parser\nhere is the file\nand more')).toBe('fix the parser');
    });

    it('carries none of a pasted document', async () => {
      const pasted = `look at this\n${'x'.repeat(5 * 1024 * 1024)}`;

      const said = await asking(pasted);

      expect(said).toBe('look at this');
    });

    /** A prompt with no line break at all is still only a row's worth of text. */
    it('cuts a single enormous line down to a label', async () => {
      const said = await asking('y'.repeat(5 * 1024 * 1024));

      expect(said.length).toBeLessThanOrEqual(300);
      expect(said.startsWith('yyy')).toBe(true);
    });

    it('says nothing for a turn that asked nothing', async () => {
      expect(await asking('')).toBe('');
    });
  });

  /**
   * The runtime's names describe its own machinery. Only the transient one needs acting on,
   * and it is the one worth calling busy.
   */
  it.each([
    ['session-busy', 'busy'],
    ['unsupported-remote-session', 'remote'],
    ['file-change-tracking-disabled', 'untracked'],
  ])('says %s is %s', async (given, expected) => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    pointsOf(harness).mockResolvedValue({
      fileChangeTrackingEnabled: false,
      unavailableReason: given,
      points: [],
    });

    expect((await harness.runtime.rewindPoints('a')).unavailable).toBe(expected);
  });

  /**
   * A session that never captured its changes cannot offer its files back, and the runtime
   * says so in a field rather than as a reason. Saying nothing would offer a way back that
   * silently did less than it promised.
   */
  it('reports tracking being off even when no reason is given', async () => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    pointsOf(harness).mockResolvedValue({ fileChangeTrackingEnabled: false, points: [] });

    expect((await harness.runtime.rewindPoints('a')).unavailable).toBe('untracked');
  });

  it('asks what a rewind would put back, before anything is done', async () => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    harness.sessions.get('a')!.rpc.history.previewRewind.mockResolvedValue({
      available: true,
      fileCount: 1,
      files: [{ path: 'F:\\work\\one.ts', changeType: 'modified', linesAdded: 4, linesRemoved: 1 }],
    });

    const preview = await harness.runtime.previewRewind('a', 'e1');

    expect(preview).toEqual({
      available: true,
      files: [{ path: 'F:\\work\\one.ts', status: 'modified', linesAdded: 4, linesRemoved: 1 }],
    });
  });

  it('asks the runtime for the files only when they were wanted', async () => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    const rewind = harness.sessions.get('a')!.rpc.history.rewind;

    await harness.runtime.rewind('a', 'e1', true);
    expect(rewind).toHaveBeenLastCalledWith({ eventId: 'e1', mode: 'conversation-and-files' });

    await harness.runtime.rewind('a', 'e1', false);
    expect(rewind).toHaveBeenLastCalledWith({ eventId: 'e1', mode: 'conversation' });
  });

  it('says what was put back and what was left alone', async () => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    harness.sessions.get('a')!.rpc.history.rewind.mockResolvedValue({
      outcome: 'success',
      eventsRemoved: 12,
      restoredFiles: ['F:\\work\\one.ts'],
      skippedFiles: [{ path: 'F:\\work\\two.ts', reason: 'changed since' }],
    });

    const result = await harness.runtime.rewind('a', 'e1', true);

    expect(result.outcome).toBe('success');
    expect(result.restoredFiles).toEqual(['F:\\work\\one.ts']);
    expect(result.skippedFiles).toEqual([{ path: 'F:\\work\\two.ts', reason: 'changed since' }]);
  });

  /**
   * The failures differ in what they left on disk, so they are not folded into one. The two
   * tidying failures are the exception: both mean it worked and something the runtime keeps
   * alongside it did not get cleaned up, which is the same thing to a reader.
   */
  it.each([
    ['success', 'success'],
    ['session-busy', 'busy'],
    ['file-change-tracking-disabled', 'untracked'],
    ['unsupported-remote-session', 'remote'],
    ['files-rolled-back', 'rolled-back'],
    ['rollback-incomplete', 'rollback-incomplete'],
    ['truncation-failed', 'truncation-failed'],
    ['checkpoint-cleanup-failed', 'partly-tidied'],
    ['snapshot-prune-failed', 'partly-tidied'],
  ])('reports %s as %s', async (given, expected) => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    harness.sessions.get('a')!.rpc.history.rewind.mockResolvedValue({
      outcome: given,
      restoredFiles: [],
      skippedFiles: [],
    });

    expect((await harness.runtime.rewind('a', 'e1', true)).outcome).toBe(expected);
  });

  // What went wrong is the runtime's to say, and dropping it would leave a reader with
  // "check the files" and nothing to check them against.
  it('carries the failure detail through', async () => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    harness.sessions.get('a')!.rpc.history.rewind.mockResolvedValue({
      outcome: 'rollback-incomplete',
      restoredFiles: [],
      skippedFiles: [],
      error: 'one.ts is read-only',
    });

    expect((await harness.runtime.rewind('a', 'e1', true)).error).toBe('one.ts is read-only');
  });
});

/**
 * Asking once about one tool call (#210).
 *
 * A write to a path outside the session's allowed directories raises two requests for a
 * single tool call - tool permission and path verification are separate gates - carrying
 * byte-identical payloads and the same `toolCallId` milliseconds apart. Nothing in the
 * second differs, so there is nothing in it to decide differently.
 */
describe('not asking twice about one tool call', () => {
  /**
   * Put the request without waiting on its answer.
   *
   * Returned unawaited on purpose: awaiting a call that answers with a promise flattens
   * the two, so `await ask(...)` would wait for the decision nobody has made yet.
   */
  const ask = (harness: ReturnType<typeof makeRuntime>, request: Record<string, unknown>, of = 'a') =>
    harness.permissionHandlers.get(of)?.(request);

  /** Let the prompt reach the UI, which happens a few microtasks after the request. */
  const prompted = async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  };

  const write = (over: Record<string, unknown> = {}) => ({
    kind: 'write',
    toolCallId: 'call-1',
    fileName: join(sep === '\\' ? 'C:\\repo' : '/repo', 'a.ts'),
    ...over,
  });

  it.each([
    ['approve-for-session', { kind: 'approve-for-session', approval: { kind: 'write' } }],
    ['approve-once', { kind: 'approve-once' }],
    ['reject', { kind: 'reject' }],
  ] as const)('answers the repeat the way %s answered the first', async (choice, expected) => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');

    const first = ask(harness, write());
    await prompted();
    harness.runtime.resolvePermission(onPermissionRequest.mock.calls[0]?.[1] as string, choice);
    await expect(first).resolves.toEqual(expected);

    // The same tool call again, which is the duplicate the two gates produce.
    const second = ask(harness, write());
    await prompted();

    await expect(second).resolves.toEqual(expected);
    expect(onPermissionRequest).toHaveBeenCalledOnce();
  });

  // A different call is a different decision, however alike the two look.
  it('asks again about a different tool call', async () => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');

    void ask(harness, write());
    await prompted();
    harness.runtime.resolvePermission(onPermissionRequest.mock.calls[0]?.[1] as string, 'approve-once');
    void ask(harness, write({ toolCallId: 'call-2' }));
    await prompted();

    expect(onPermissionRequest).toHaveBeenCalledTimes(2);
  });

  // Two sessions can be running the same tool call id without having agreed about anything.
  it('asks again in another session', async () => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');
    await harness.runtime.send('b', 'y');

    void ask(harness, write());
    await prompted();
    harness.runtime.resolvePermission(onPermissionRequest.mock.calls[0]?.[1] as string, 'approve-once');
    void ask(harness, write(), 'b');
    await prompted();

    expect(onPermissionRequest).toHaveBeenCalledTimes(2);
  });

  /**
   * The one thing this must not do. A request that lapsed was decided by a clock rather
   * than by anybody, and standing in for somebody who never answered would turn one
   * unanswered question into a standing answer.
   */
  it('asks again after a question nobody answered', async () => {
    vi.useFakeTimers();
    try {
      const onPermissionRequest = vi.fn();
      const harness = makeRuntime({ onPermissionRequest, permissionTimeoutMs: 1000 });
      await harness.runtime.send('a', 'x');

      const first = ask(harness, write());
      await prompted();
      await vi.advanceTimersByTimeAsync(1500);
      await expect(first).resolves.toEqual({ kind: 'user-not-available' });

      void ask(harness, write());
      await prompted();

      expect(onPermissionRequest).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Nothing to key the answer by, so nothing is remembered and nothing is skipped.
  it('asks every time about a request naming no tool call', async () => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');

    void ask(harness, { kind: 'shell', fullCommandText: 'ls' });
    await prompted();
    harness.runtime.resolvePermission(onPermissionRequest.mock.calls[0]?.[1] as string, 'approve-once');
    void ask(harness, { kind: 'shell', fullCommandText: 'ls' });
    await prompted();

    expect(onPermissionRequest).toHaveBeenCalledTimes(2);
  });
});

/**
 * Letting a session work in a directory, so it stops being asked about (#210).
 *
 * Tool permission and path verification are separate gates. A path outside the session's
 * allowed directories trips both, which is what raises two requests for one edit. Allowing
 * the directory stops the path gate firing for what comes after it - not for the call in
 * flight, whose second request has already been raised by the time anybody can answer the
 * first. That one is handled by not asking twice about a tool call at all.
 */
describe('offering to allow a directory', () => {
  /**
   * Built with the platform's own separator rather than written out.
   *
   * `dirname` answers for the platform it runs on: given a Windows path on Linux it finds
   * no separator and says `.`, so a test with `C:\...` written into it passes on Windows
   * and fails in CI. The paths a session actually names are always the host's own.
   */
  const outside = join(sep === '\\' ? 'C:\\Users\\me' : '/home/me', 'Downloads');
  const inside = join(sep === '\\' ? 'C:\\repo' : '/repo', 'src');

  const allowed = (harness: ReturnType<typeof makeRuntime>) =>
    harness.sessions.get('a')!.rpc.permissions.paths.isPathWithinAllowedDirectories;

  const ask = async (harness: ReturnType<typeof makeRuntime>, request: Record<string, unknown>) => {
    void harness.permissionHandlers.get('a')?.(request);
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  };

  it('offers the directory when the path is outside what is allowed', async () => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');
    allowed(harness).mockResolvedValue({ allowed: false });

    await ask(harness, { kind: 'write', fileName: join(outside, 'a.txt') });

    expect(onPermissionRequest.mock.calls[0]?.[4]).toBe(outside);
  });

  // Offering it would be offering to do nothing, and the second ask is not happening anyway.
  it('offers nothing when the path is already allowed', async () => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');
    allowed(harness).mockResolvedValue({ allowed: true });

    await ask(harness, { kind: 'write', fileName: join(inside, 'a.txt') });

    expect(onPermissionRequest.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('offers nothing for a request that names no path', async () => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');
    allowed(harness).mockResolvedValue({ allowed: false });

    await ask(harness, { kind: 'shell', fullCommandText: 'ls' });

    expect(onPermissionRequest.mock.calls[0]?.[4]).toBeUndefined();
    expect(allowed(harness)).not.toHaveBeenCalled();
  });

  // Allowing a whole drive is allowing everything, which the setting beside this already does.
  it('never offers the root of the filesystem', async () => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');
    allowed(harness).mockResolvedValue({ allowed: false });

    await ask(harness, { kind: 'write', fileName: join(sep === '\\' ? 'C:\\' : '/', 'a.txt') });

    expect(onPermissionRequest.mock.calls[0]?.[4]).toBeUndefined();
  });

  /**
   * The prompt still has to be raised. A runtime that cannot answer whether a path is
   * allowed has said nothing about the request itself, and swallowing it would leave the
   * agent blocked on a question nobody was asked.
   */
  it('still asks when the runtime cannot say what is allowed', async () => {
    const onPermissionRequest = vi.fn();
    const harness = makeRuntime({ onPermissionRequest });
    await harness.runtime.send('a', 'x');
    allowed(harness).mockRejectedValue(new Error('no such method'));

    await ask(harness, { kind: 'write', fileName: join(outside, 'a.txt') });

    expect(onPermissionRequest).toHaveBeenCalledOnce();
    expect(onPermissionRequest.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('adds the directory when it is asked to', async () => {
    const harness = makeRuntime();

    await expect(harness.runtime.allowFolder('a', outside)).resolves.toEqual({ allowed: true });
    expect(harness.sessions.get('a')!.rpc.permissions.paths.add).toHaveBeenCalledWith({ path: outside });
  });

  it('says so when the runtime refuses the directory', async () => {
    const harness = makeRuntime();
    await harness.runtime.load('a');
    harness.sessions.get('a')!.rpc.permissions.paths.add.mockResolvedValue({ success: false });

    await expect(harness.runtime.allowFolder('a', outside)).resolves.toEqual({ allowed: false });
  });
});

/**
 * What the running turn has touched, kept until the store takes over (#140).
 *
 * The runtime is where this lives because it sees every session's events all the time. The
 * app only has the session on screen, and only the pages of it that have been read.
 */
describe('SessionRuntime watching a running turn', () => {
  // Held per session until the turn ends, so each test has to start from nothing.
  let liveMod: typeof import('./liveChanges.js');
  const live = async () => liveMod;

  beforeEach(async () => {
    liveMod = await import('./liveChanges.js');
    liveMod.forgetLive('a');
  });

  /** A write and the diff it reports, which is what the tracker reads. */
  const wrote = (session: { emit: (e: unknown) => void }, path: string, id = 'c1') => {
    const patch = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,1 +1,1 @@',
      '-one',
      '+two',
    ].join('\n');

    session.emit({ type: 'tool.execution_start', data: { toolCallId: id, toolName: 'edit', arguments: { path } } });
    session.emit({
      type: 'tool.execution_complete',
      data: { toolCallId: id, success: true, result: { detailedContent: patch } },
    });
  };

  it('keeps what a file tool changed', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');

    wrote(sessions.get('a')!, 'a.ts');

    expect((await live()).liveChanges('a').map((c) => c.path)).toEqual(['a.ts']);
  });

  it('says so, so a panel knows to read again', async () => {
    const onChangesRecorded = vi.fn();
    const { runtime, sessions } = makeRuntime({ onChangesRecorded });
    await runtime.send('a', 'make a file');

    wrote(sessions.get('a')!, 'a.ts');

    expect(onChangesRecorded).toHaveBeenCalledWith('a');
  });

  /** Most calls are reads, and one notification apiece would re-read the store constantly. */
  it('says nothing for a tool that only read', async () => {
    const onChangesRecorded = vi.fn();
    const { runtime, sessions } = makeRuntime({ onChangesRecorded });
    await runtime.send('a', 'look at a file');

    const session = sessions.get('a')!;
    session.emit({ type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'view', arguments: { path: 'a.ts' } } });
    session.emit({ type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true } });

    expect(onChangesRecorded).not.toHaveBeenCalled();
  });

  it('keeps nothing from a write that failed', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');

    const session = sessions.get('a')!;
    session.emit({
      type: 'tool.execution_start',
      data: { toolCallId: 'c1', toolName: 'edit', arguments: { path: 'a.ts', old_str: 'one', new_str: 'two' } },
    });
    session.emit({ type: 'tool.execution_complete', data: { toolCallId: 'c1', success: false } });

    expect((await live()).liveChanges('a')).toEqual([]);
  });

  /**
   * The store becomes the record when the session goes idle. Keeping this past that moment
   * would count every one of these changes twice, once live and once from the snapshot.
   */
  it('hands over to the store when the session goes idle', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');
    const session = sessions.get('a')!;
    wrote(session, 'a.ts');

    session.emit({ type: 'session.idle', data: {} });

    expect((await live()).liveChanges('a')).toEqual([]);
  });

  /** A request that calls tools ends and starts a turn nine times over on average. */
  it('keeps it across the round trips within one turn', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');
    const session = sessions.get('a')!;
    wrote(session, 'a.ts');

    session.emit({ type: 'assistant.turn_end', data: {} });
    session.emit({ type: 'assistant.turn_start', data: {} });

    expect((await live()).liveChanges('a')).toHaveLength(1);
  });

  it('drops it when the turn is interrupted', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');
    const session = sessions.get('a')!;
    wrote(session, 'a.ts');

    session.emit({ type: 'abort', data: {} });

    expect((await live()).liveChanges('a')).toEqual([]);
  });

  /** Whoever reads the list on the idle notification must see the store, not the store plus this. */
  it('has already handed over by the time it announces the turn is done', async () => {
    const seen: number[] = [];
    const { runtime, sessions } = makeRuntime({
      onChangesRecorded: () => seen.push(liveMod.liveChanges('a').length),
    });
    await runtime.send('a', 'make a file');
    const session = sessions.get('a')!;
    wrote(session, 'a.ts');

    session.emit({ type: 'session.idle', data: {} });

    // The write announced one, and the idle announced none: the handover happened between.
    expect(seen).toEqual([1, 0]);
  });
});

/**
 * Reading what a session changed must never wait on the session (#140).
 *
 * The flush exists to make the runtime write out a turn it is still holding. While a turn
 * is in flight there is nothing it could write that would help, and asking anyway puts a
 * request to a busy runtime in front of an answer somebody is waiting for - so a panel
 * watching a working session would be waiting on the work rather than describing it.
 */
describe('SessionRuntime flushing while a turn is running', () => {
  it('asks nothing of a session that is working', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');
    const session = sessions.get('a')!;
    session.emit({ type: 'assistant.turn_start', data: {} });
    session.rpc.history.listRewindPoints.mockClear();

    await runtime.flushChanges('a');

    expect(session.rpc.history.listRewindPoints).not.toHaveBeenCalled();
  });

  it('answers at once rather than waiting on the turn', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');
    const session = sessions.get('a')!;
    // A runtime that serves nothing until its turn is done, which is the case that hung.
    session.rpc.history.listRewindPoints.mockImplementation(() => new Promise(() => {}));
    session.emit({ type: 'assistant.turn_start', data: {} });

    await expect(runtime.flushChanges('a')).resolves.toBeUndefined();
  });

  it('asks again once the turn is over', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');
    const session = sessions.get('a')!;
    session.emit({ type: 'assistant.turn_start', data: {} });
    session.emit({ type: 'session.idle', data: {} });
    session.rpc.history.listRewindPoints.mockClear();

    await runtime.flushChanges('a');

    expect(session.rpc.history.listRewindPoints).toHaveBeenCalled();
  });

  it('asks again once the turn is interrupted', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('a', 'make a file');
    const session = sessions.get('a')!;
    session.emit({ type: 'assistant.turn_start', data: {} });
    session.emit({ type: 'abort', data: {} });
    session.rpc.history.listRewindPoints.mockClear();

    await runtime.flushChanges('a');

    expect(session.rpc.history.listRewindPoints).toHaveBeenCalled();
  });
});

/**
 * Changing your mind about something already waiting (#76).
 *
 * The runtime owns the queue and consumes from it as the turn runs, so everything here asks
 * rather than decides. A session nobody is holding has no queue at all.
 */
describe('changing the queue the runtime owns', () => {
  it('takes an entry back by the id the queue gave it', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');

    await expect(runtime.queueRemove('s1', 'q1')).resolves.toBe(true);
    expect(sessions.get('s1')!.rpc.queue.removeAt).toHaveBeenCalledWith({ id: 'q1' });
  });

  /** What is sent to the model is what was shown, because the reader wrote it. */
  it('rewrites an entry, shown and sent alike', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');

    await expect(runtime.queueEdit('s1', 'q1', 'something else')).resolves.toBe(true);
    expect(sessions.get('s1')!.rpc.queue.updateText).toHaveBeenCalledWith({
      id: 'q1',
      prompt: 'something else',
      displayPrompt: 'something else',
    });
  });

  it('moves an entry to a position in the queue as it is shown', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');

    await expect(runtime.queueMove('s1', 'q3', 1)).resolves.toBe(true);
    expect(sessions.get('s1')!.rpc.queue.moveItem).toHaveBeenCalledWith({ id: 'q3', toPosition: 1 });
  });

  it('drops everything waiting', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');

    await expect(runtime.queueClear('s1')).resolves.toBe(true);
    expect(sessions.get('s1')!.rpc.queue.clear).toHaveBeenCalled();
  });

  /** Taken by the turn while the call was on its way, which is changing your mind too late. */
  it('says so when the entry has already gone', async () => {
    const { runtime, sessions } = makeRuntime();
    await runtime.send('s1', 'hello');
    sessions.get('s1')!.rpc.queue.removeAt.mockResolvedValueOnce({ removed: false });

    await expect(runtime.queueRemove('s1', 'q1')).resolves.toBe(false);
  });

  /**
   * No queue to change, and nothing worth waking a session for: the queue lives in the
   * running session and a cold one has nothing waiting by definition.
   */
  it('changes nothing for a session nobody is holding', async () => {
    const { runtime, sessions } = makeRuntime();

    await expect(runtime.queueRemove('cold', 'q1')).resolves.toBe(false);
    await expect(runtime.queueEdit('cold', 'q1', 'x')).resolves.toBe(false);
    await expect(runtime.queueMove('cold', 'q1', 0)).resolves.toBe(false);
    await expect(runtime.queueClear('cold')).resolves.toBe(false);
    expect(sessions.size).toBe(0);
  });
});
