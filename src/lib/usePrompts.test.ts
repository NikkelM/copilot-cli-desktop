// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingElicitation, PendingPermission } from '../../shared/protocol';

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
};

const { resolvePermission, resolveElicitation } = vi.hoisted(() => ({
  resolvePermission: vi.fn(),
  resolveElicitation: vi.fn(),
}));

vi.mock('./sidecar', () => ({
  resolvePermission,
  resolveElicitation,
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
  });

  it('starts with nothing waiting', () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    expect(result.current.permissions).toEqual([]);
    expect(result.current.elicitations).toEqual([]);
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
  });

  /**
   * The sidebar marks every waiting session, so requests for sessions that are not on
   * screen are kept; only the pane's copy is narrowed to the one being read.
   */
  it('keeps other sessions requests but shows only this session', async () => {
    const { result } = renderHook(() => usePrompts('s1', () => {}));

    await emit('permissionRequested', permission('r1', 's1'));
    await emit('permissionRequested', permission('r2', 's2'));

    expect(result.current.permissions).toHaveLength(2);
    expect(result.current.mine.permissions.map((p) => p.requestId)).toEqual(['r1']);
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

    act(() => result.current.clear());

    expect(result.current.permissions).toEqual([]);
    expect(result.current.elicitations).toEqual([]);
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
});
