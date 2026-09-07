import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRuntime, type RuntimeOptions } from './runtime.js';

/**
 * The tests that track what a turn changed spawn git, several times over.
 *
 * The default five seconds is a limit on how long a piece of pure logic may take, and those
 * are not that: one was measured at 3.2s alone, which leaves nothing for a machine that is
 * also running the app. It failed exactly that way under load while passing on its own.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
    // realpath.native, because these tests compare a path the runtime derived from git
    // against one built here. On a Windows machine whose TMP is an 8.3 short name - which
    // the GitHub runners have, as `RUNNER~1` - the two spell the same directory differently
    // and the comparison fails for a reason unrelated to what is being tested.
    //
    // The native variant specifically: plain realpathSync resolves symlinks but leaves a
    // short name short, which was measured rather than assumed.
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'ccd-runtime-git-')));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
    // Signing is the reader's own setting, and inheriting it makes these tests wait on a
    // GPG agent that has nothing to do with what they are testing.
    execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false']);
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
 * The runtime answers for the repository, and only for it. What a file tool changed
 * anywhere on disk is kept in the log and shown on the row that made it, which is where
 * that half is tested - a session outside a repository has nothing to snapshot and
 * nothing to rewind to, and saying so plainly beats half an answer.
 */

/**
 * Each point holds a git ref, and a ref stops git collecting the tree behind it. A long
 * session left running would pin a copy of the working tree per turn indefinitely, in the
 * reader's own repository.
 */
describe('SessionRuntime letting go of old points', () => {
  let repo: string;

  beforeEach(() => {
    // realpath.native for the same reason as above: a short-name TMP would make any
    // comparison against a path git reported spell the same directory two ways.
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'ccd-runtime-keep-')));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
    // Signing is the reader's own setting, and inheriting it makes these tests wait on a
    // GPG agent that has nothing to do with what they are testing.
    execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const refs = () =>
    execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/copilot-desktop'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

  it('keeps a bounded history however many turns a session takes', async () => {
    const { runtime, sessions } = makeRuntime({ lookupCwd: () => repo, maxSnapshotPoints: 5 });
    await runtime.send('a', 'go');
    const session = sessions.get('a')!;

    for (let i = 0; i < 9; i += 1) {
      session.emit({ type: 'assistant.turn_start' });
      await runtime.changes('a');
    }

    expect(refs().length).toBe(5);
  }, 30_000);

  // What a session's whole work is measured against; losing it loses the session's diff.
  it('never lets go of the baseline', async () => {
    const { runtime, sessions } = makeRuntime({ lookupCwd: () => repo, maxSnapshotPoints: 5 });
    await runtime.send('a', 'go');
    const session = sessions.get('a')!;

    for (let i = 0; i < 9; i += 1) {
      session.emit({ type: 'assistant.turn_start' });
      await runtime.changes('a');
    }

    expect(refs().some((ref) => ref.endsWith('/baseline'))).toBe(true);
  }, 30_000);
});
describe('SessionRuntime outside any repository', () => {
  let loose: string;

  beforeEach(() => {
    loose = mkdtempSync(join(tmpdir(), 'ccd-runtime-loose-'));
  });

  afterEach(() => rmSync(loose, { recursive: true, force: true }));

  it('has nothing to report where there is nothing to compare against', async () => {
    const { runtime, sessions } = makeRuntime({ lookupCwd: () => loose });
    await runtime.send('a', 'go');

    sessions.get('a')!.emit({ type: 'assistant.turn_start' });

    expect(await runtime.changes('a')).toBeNull();
    expect(await runtime.diff('a', join(loose, 'notes.txt'))).toBeNull();
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
