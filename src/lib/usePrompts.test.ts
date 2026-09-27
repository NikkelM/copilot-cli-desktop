// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PendingElicitation,
  PendingPermission,
  PendingPlanApproval,
} from '../../shared/protocol';

import { usePrompts } from './usePrompts';

/**
 * Each subscription hands its handler back so a test can deliver an event, standing in for
 * the sidecar that would otherwise have to be running.
 */
const listeners = {
  permissionRequested: [] as ((p: unknown) => void)[],
  permissionResolved: [] as ((p: unknown) => void)[],
  elicitationRequested: [] as ((p: unknown) => void)[],
  elicitationResolved: [] as ((p: unknown) => void)[],
  planRequested: [] as ((p: unknown) => void)[],
  planResolved: [] as ((p: unknown) => void)[],
};

const { resolvePermission, resolveElicitation, resolvePlan, allowSessionFolder } = vi.hoisted(() => ({
  resolvePermission: vi.fn(),
  allowSessionFolder: vi.fn(async () => ({ allowed: true })),
  resolveElicitation: vi.fn(),
  resolvePlan: vi.fn(),
}));

vi.mock('./sidecar', () => ({
  resolvePermission,
  allowSessionFolder,
  resolveElicitation,
  resolvePlan,
  onPermissionRequested: (h: (p: unknown) => void) => {
    listeners.permissionRequested.push(h);
    return Promise.resolve(() => {});
  },
  onPermissionResolved: (h: (p: unknown) => void) => {
    listeners.permissionResolved.push(h);
    return Promise.resolve(() => {});
  },
  onElicitationRequested: (h: (p: unknown) => void) => {
    listeners.elicitationRequested.push(h);
    return Promise.resolve(() => {});
  },
  onElicitationResolved: (h: (p: unknown) => void) => {
    listeners.elicitationResolved.push(h);
    return Promise.resolve(() => {});
  },
  onPlanRequested: (h: (p: unknown) => void) => {
    listeners.planRequested.push(h);
    return Promise.resolve(() => {});
  },
  onPlanResolved: (h: (p: unknown) => void) => {
    listeners.planResolved.push(h);
    return Promise.resolve(() => {});
  },
}));

const permission = (requestId: string, sessionId = 's1'): PendingPermission => ({
  requestId,
  sessionId,
  request: { tool: 'shell' },
  expiresAt: '2026-01-02T00:05:00.000Z',
});

const elicitation = (requestId: string, sessionId = 's1'): PendingElicitation => ({
  requestId,
  sessionId,
  kind: 'form',
  message: 'Which one?',
  schema: { properties: {} },
  choices: [],
  mode: 'form',
  url: null,
  expiresAt: '2026-01-02T00:05:00.000Z',
});

const plan = (requestId: string, sessionId = 's1'): PendingPlanApproval => ({
  requestId,
  sessionId,
  summary: 'Rewrite the parser',
  planContent: '1. Read it\n2. Rewrite it',
  actions: ['interactive', 'autopilot'],
  recommendedAction: 'autopilot',
  expiresAt: '2026-01-02T00:05:00.000Z',
});

/** Deliver an event to every handler registered for it, as Tauri would. */
async function emit(which: keyof typeof listeners, payload: unknown) {
  await waitFor(() => expect(listeners[which].length).toBeGreaterThan(0));
  act(() => listeners[which].forEach((h) => h(payload)));
}

describe('usePrompts', () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners) as (keyof typeof listeners)[]) listeners[key] = [];
    resolvePermission.mockReset().mockResolvedValue(undefined);
    resolveElicitation.mockReset().mockResolvedValue(undefined);
    resolvePlan.mockReset().mockResolvedValue(undefined);
  });

  it('starts with nothing waiting', () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    expect(result.current.permissions).toEqual([]);
    expect(result.current.elicitations).toEqual([]);
    expect(result.current.plans).toEqual([]);
    expect(result.current.blocked).toBe(false);
  });

  it('holds a permission request until it is answered', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit('permissionRequested', permission('r1'));
    expect(result.current.permissions).toHaveLength(1);
    expect(result.current.blocked).toBe(true);

    act(() => result.current.answerPermission(permission('r1'), 'approve-once'));
    expect(result.current.permissions).toEqual([]);
    expect(resolvePermission).toHaveBeenCalledWith('s1', 'r1', 'approve-once');
  });

  it('holds an elicitation until it is answered', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit('elicitationRequested', elicitation('e1'));
    expect(result.current.elicitations).toHaveLength(1);

    act(() => result.current.answerElicitation(elicitation('e1'), 'accept', { a: 'b' }));
    expect(result.current.elicitations).toEqual([]);
    expect(resolveElicitation).toHaveBeenCalledWith('e1', 'accept', { a: 'b' });
  });

  it('holds a plan until it is approved', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit('planRequested', plan('p1'));
    expect(result.current.plans).toHaveLength(1);
    expect(result.current.blocked).toBe(true);

    act(() => result.current.answerPlan(plan('p1'), true, 'autopilot'));
    expect(result.current.plans).toEqual([]);
    expect(resolvePlan).toHaveBeenCalledWith('p1', true, 'autopilot', undefined);
  });

  // Turning a plan down is the half that carries something back: the feedback is what the
  // agent plans against on its next attempt.
  it('sends the feedback a refused plan came with', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));
    await emit('planRequested', plan('p1'));

    act(() => result.current.answerPlan(plan('p1'), false, undefined, 'too much at once'));

    expect(resolvePlan).toHaveBeenCalledWith('p1', false, undefined, 'too much at once');
  });

  /**
   * The runtime rejects a second answer to the same request, so a double click must not
   * produce one. The prompt goes the moment it is answered rather than when the call
   * returns, which is the window a second click would land in.
   */
  it('cannot answer the same permission twice', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));
    await emit('permissionRequested', permission('r1'));

    act(() => {
      result.current.answerPermission(permission('r1'), 'approve-once');
      result.current.answerPermission(permission('r1'), 'reject');
    });

    expect(resolvePermission).toHaveBeenCalledTimes(1);
  });

  /**
   * The way this really happens: the request is settled somewhere else - answered in a
   * terminal, or expired - while a click is already on its way. The runtime rejects the
   * late answer, and the reader would be shown an error for something they did right.
   */
  it('does not answer a request that was already settled elsewhere', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));
    await emit('permissionRequested', permission('r1'));

    await emit('permissionResolved', { requestId: 'r1' });
    act(() => result.current.answerPermission(permission('r1'), 'approve-once'));

    expect(resolvePermission).not.toHaveBeenCalled();
  });

  // The same request arriving twice would otherwise draw two prompts, only one of which
  // can be answered.
  it('ignores a repeated request', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit('permissionRequested', permission('r1'));
    await emit('permissionRequested', permission('r1'));

    expect(result.current.permissions).toHaveLength(1);

    await emit('planRequested', plan('p1'));
    await emit('planRequested', plan('p1'));

    expect(result.current.plans).toHaveLength(1);
  });

  // Answered in a terminal, or by another window: the prompt here is stale either way.
  it('drops a request resolved elsewhere', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));
    await emit('permissionRequested', permission('r1'));

    await emit('permissionResolved', { requestId: 'r1' });
    expect(result.current.permissions).toEqual([]);

    await emit('elicitationRequested', elicitation('e1'));
    await emit('elicitationResolved', { requestId: 'e1' });
    expect(result.current.elicitations).toEqual([]);

    await emit('planRequested', plan('p1'));
    await emit('planResolved', { requestId: 'p1' });
    expect(result.current.plans).toEqual([]);

    // And a late answer to it is not sent, because the runtime rejects a second one.
    act(() => result.current.answerPlan(plan('p1'), true, 'autopilot'));
    expect(resolvePlan).not.toHaveBeenCalled();
  });

  /**
   * The sidebar marks every waiting session, so requests for sessions that are not on
   * screen are kept; only the pane's copy is narrowed to the one being read.
   */
  it('keeps other sessions requests but shows only this session', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit('permissionRequested', permission('r1', 's1'));
    await emit('permissionRequested', permission('r2', 's2'));
    await emit('planRequested', plan('p1', 's1'));
    await emit('planRequested', plan('p2', 's2'));

    expect(result.current.permissions).toHaveLength(2);
    expect(result.current.mine.permissions.map((p) => p.requestId)).toEqual(['r1']);
    expect(result.current.plans).toHaveLength(2);
    expect(result.current.mine.plans.map((p) => p.requestId)).toEqual(['p1']);
  });

  it('follows the session being read', async () => {
    const { result, rerender } = renderHook(({ id }) => usePrompts(id, () => {}), {
      initialProps: { id: 's1' as string | null },
    });

    await emit('permissionRequested', permission('r2', 's2'));
    expect(result.current.blocked).toBe(false);

    rerender({ id: 's2' });
    expect(result.current.mine.permissions.map((p) => p.requestId)).toEqual(['r2']);
    expect(result.current.blocked).toBe(true);
  });

  // Nothing is answered on the way out: the runtime that asked is gone.
  it('forgets everything when the sidecar goes', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));
    await emit('permissionRequested', permission('r1'));
    await emit('elicitationRequested', elicitation('e1'));
    await emit('planRequested', plan('p1'));

    act(() => result.current.clear());

    expect(result.current.permissions).toEqual([]);
    expect(result.current.elicitations).toEqual([]);
    expect(result.current.plans).toEqual([]);
    expect(resolvePermission).not.toHaveBeenCalled();
  });

  it('reports an answer that could not be delivered', async () => {
    resolvePermission.mockRejectedValue(new Error('session is gone'));
    const failed: string[] = [];
    const { result } = renderHook(() => usePrompts('s1', (m) => failed.push(m)));
    await emit('permissionRequested', permission('r1'));

    act(() => result.current.answerPermission(permission('r1'), 'approve-once'));

    await waitFor(() => expect(failed.join()).toContain('session is gone'));
    // Still gone from the screen: it cannot be answered again, and saying so is the point
    // of the message.
    expect(result.current.permissions).toEqual([]);
  });

  it('reports a plan answer that could not be delivered', async () => {
    resolvePlan.mockRejectedValue(new Error('session is gone'));
    const failed: string[] = [];
    const { result } = renderHook(() => usePrompts('s1', (m) => failed.push(m)));
    await emit('planRequested', plan('p1'));

    act(() => result.current.answerPlan(plan('p1'), true, 'autopilot'));

    await waitFor(() => expect(failed.join()).toContain('session is gone'));
  });
});

/**
 * The one list that says "an agent is stopped here", whatever it is stopped by.
 *
 * Assembled here rather than by each caller, because a caller that had to remember all three
 * could leave one out and the sidebar would go on calling a session idle while it sat waiting
 * on a question (#187).
 */
describe('what has an agent stopped', () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners) as (keyof typeof listeners)[]) listeners[key] = [];
    resolvePermission.mockReset().mockResolvedValue(undefined);
    resolveElicitation.mockReset().mockResolvedValue(undefined);
    resolvePlan.mockReset().mockResolvedValue(undefined);
  });

  it('is empty when nothing is', () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    expect(result.current.blocking).toEqual([]);
  });

  it.each([
    ['a permission', 'permissionRequested' as const, () => permission('r1')],
    ['a question', 'elicitationRequested' as const, () => elicitation('r1')],
    ['a plan', 'planRequested' as const, () => plan('r1')],
  ])('counts %s', async (_what, channel, make) => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit(channel, make());

    expect(result.current.blocking.map((p) => p.sessionId)).toEqual(['s1']);
  });

  it('gathers all three kinds at once', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit('permissionRequested', permission('r1', 'a'));
    await emit('elicitationRequested', elicitation('r2', 'b'));
    await emit('planRequested', plan('r3', 'c'));

    expect(result.current.blocking.map((p) => p.sessionId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('covers every session, not only the one on screen', async () => {
    // The sidebar asks about all of them; the composer is the one that only cares about this.
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit('elicitationRequested', elicitation('r1', 'somewhere-else'));

    expect(result.current.blocking.map((p) => p.sessionId)).toEqual(['somewhere-else']);
    expect(result.current.blocked).toBe(false);
  });
});
/**
 * Allowing the directory a write is outside of (#210).
 *
 * Two things, in that order: allowing the folder is what stops the second ask next time,
 * and the request in front of the reader still has to be answered.
 */
describe('allowing a folder from the prompt', () => {
  const asking = () => ({
    sessionId: 's1',
    requestId: 'r1',
    request: { kind: 'write', fileName: 'C:\\Users\\me\\Downloads\\a.txt' },
    offerFolder: 'C:\\Users\\me\\Downloads',
    expiresAt: null,
  });

  it('allows the folder and answers the request that raised it', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));
    await waitFor(() => expect(listeners.permissionRequested.length).toBeGreaterThan(0));
    act(() => listeners.permissionRequested.forEach((h) => h(asking())));

    await act(async () => {
      result.current.allowFolder(result.current.permissions[0]!, 'C:\\Users\\me\\Downloads');
    });

    expect(allowSessionFolder).toHaveBeenCalledWith('s1', 'C:\\Users\\me\\Downloads');
    expect(resolvePermission).toHaveBeenCalledWith('s1', 'r1', 'approve-once');
  });

  /**
   * The agent is blocked on the request whatever happened to the folder, so a refusal that
   * left it unanswered would be worse than one that answered it.
   */
  it('still answers the request when the folder could not be allowed', async () => {
    allowSessionFolder.mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(() => usePrompts('s1', () => {}));
    await waitFor(() => expect(listeners.permissionRequested.length).toBeGreaterThan(0));
    act(() => listeners.permissionRequested.forEach((h) => h(asking())));

    await act(async () => {
      result.current.allowFolder(result.current.permissions[0]!, 'C:\\Users\\me\\Downloads');
    });

    expect(resolvePermission).toHaveBeenCalledWith('s1', 'r1', 'approve-once');
  });

  it('takes the prompt down once it has been answered', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));
    await waitFor(() => expect(listeners.permissionRequested.length).toBeGreaterThan(0));
    act(() => listeners.permissionRequested.forEach((h) => h(asking())));

    await act(async () => {
      result.current.allowFolder(result.current.permissions[0]!, 'C:\\Users\\me\\Downloads');
    });

    expect(result.current.permissions).toHaveLength(0);
  });
});
