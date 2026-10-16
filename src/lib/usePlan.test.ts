// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEventNotification, SessionPlan } from '../../shared/protocol';
import { read, save } from './store';
import { usePlan } from './usePlan';

const { sessionPlan, saveSessionPlan, sendMessage, watchSessionPlan, onSessionEvent, onSidecarRestarted } = vi.hoisted(() => ({
  sessionPlan: vi.fn(), saveSessionPlan: vi.fn(), sendMessage: vi.fn(), watchSessionPlan: vi.fn(), onSessionEvent: vi.fn(), onSidecarRestarted: vi.fn(),
}));
vi.mock('./sidecar', () => ({ sessionPlan, saveSessionPlan, sendMessage, watchSessionPlan, onSessionEvent, onSidecarRestarted }));
const listeners = new Set<(payload: SessionEventNotification) => void>();
const original: SessionPlan = { content: '# Original', revision: 'r1', path: 'C:\\s1\\plan.md' };
const watching = (id: string | null = 's1') => renderHook(
  ({ id }: { id: string | null }) => usePlan(id), { initialProps: { id } },
);
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const emit = (id: string, type = 'session.plan_file_changed', data: unknown = {}) => {
  act(() => {
    for (const listener of listeners) listener({ sessionId: id, event: { type, data } });
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  listeners.clear();
  sessionPlan.mockReset().mockResolvedValue(original);
  watchSessionPlan.mockReset().mockResolvedValue(undefined);
  saveSessionPlan.mockReset().mockResolvedValue({ ...original, content: '# Saved', revision: 'r2' });
  sendMessage.mockReset().mockResolvedValue({ messageId: 'notice', queued: false });
  onSessionEvent.mockReset().mockImplementation((listener) => {
    listeners.add(listener);
    return Promise.resolve(() => listeners.delete(listener));
  });
  onSidecarRestarted.mockReset().mockResolvedValue(() => undefined);
});
afterEach(() => vi.useRealTimers());

describe('session plan state', () => {
  it('restores the watcher after a sidecar restart without dropping a draft', async () => {
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('kept through restart'));
    watchSessionPlan.mockClear();
    act(() => onSidecarRestarted.mock.calls[0][0]());
    await settle();
    expect(watchSessionPlan).toHaveBeenLastCalledWith('s1');
    expect(sessionPlan).toHaveBeenCalledTimes(2);
    expect(view.result.current.draft?.content).toBe('kept through restart');
  });

  it('reads and watches the selected session, never asks for a null session, and stops on unmount', async () => {
    const view = watching(null);
    await settle();
    expect(sessionPlan).not.toHaveBeenCalled();
    view.rerender({ id: 's1' });
    await settle();
    expect(watchSessionPlan).toHaveBeenLastCalledWith('s1');
    expect(sessionPlan).toHaveBeenCalledExactlyOnceWith('s1');
    expect(view.result.current.plan).toEqual(original);
    view.unmount();
    expect(watchSessionPlan).toHaveBeenLastCalledWith(null);
  });

  it('debounces filesystem and runtime changes, ignoring other sessions and unrelated events', async () => {
    const view = watching();
    await settle();
    sessionPlan.mockClear().mockResolvedValue({ ...original, content: '# Updated', revision: 'r2' });
    emit('s2');
    emit('s1', 'assistant.message');
    await act(async () => vi.advanceTimersByTime(150));
    expect(sessionPlan).not.toHaveBeenCalled();
    emit('s1');
    emit('s1', 'session.plan_changed');
    await act(async () => vi.advanceTimersByTime(149));
    expect(sessionPlan).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(sessionPlan).toHaveBeenCalledExactlyOnceWith('s1');
    expect(view.result.current.plan?.content).toBe('# Updated');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not apply a late read from the previous session or an older read', async () => {
    let answer!: (value: SessionPlan) => void;
    sessionPlan.mockReturnValueOnce(new Promise<SessionPlan>((resolve) => { answer = resolve; }));
    const view = watching();
    await settle();
    view.rerender({ id: 's2' });
    sessionPlan.mockResolvedValue({ ...original, content: '# Other' });
    await settle();
    await act(async () => answer(original));
    expect(view.result.current.plan?.content).toBe('# Other');
    sessionPlan.mockReturnValueOnce(new Promise<SessionPlan>((resolve) => { answer = resolve; }));
    act(() => { void view.result.current.refresh(); });
    sessionPlan.mockResolvedValue({ ...original, content: '# Latest' });
    await act(async () => { await view.result.current.refresh(); });
    await act(async () => answer(original));
    expect(view.result.current.plan?.content).toBe('# Latest');
  });

  it('persists separate drafts across session changes, panel remounts, and hook remounts', async () => {
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# My draft'));
    view.rerender({ id: 's2' });
    await settle();
    expect(view.result.current.draft).toBeUndefined();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Other draft'));
    view.rerender({ id: 's1' });
    await settle();
    expect(view.result.current.draft?.content).toBe('# My draft');
    view.unmount();
    const next = watching();
    await settle();
    expect(next.result.current.draft).toEqual({ content: '# My draft', revision: 'r1' });
    act(() => next.result.current.discard());
    expect(next.result.current.draft).toBeUndefined();
    expect(JSON.parse(read('sessions', 'sessionPlanDrafts')!)).toEqual({
      s2: { content: '# Other draft', revision: 'r1' },
    });
  });

  it('keeps drafts on external changes or deletion and identifies the conflict', async () => {
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('local edit'));
    sessionPlan.mockResolvedValue({ ...original, revision: 'agent' });
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.conflict).toBe(true);
    expect(view.result.current.draft?.content).toBe('local edit');
    sessionPlan.mockResolvedValue(null);
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.plan).toBeNull();
    expect(view.result.current.conflict).toBe(true);
    expect(view.result.current.draft?.content).toBe('local edit');
  });

  it('sends the original revision when saving and clears only the saved draft', async () => {
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Saved'));
    await act(async () => { await view.result.current.save(); });
    expect(saveSessionPlan).toHaveBeenCalledExactlyOnceWith('s1', '# Saved', 'r1');
    expect(view.result.current.plan?.revision).toBe('r2');
    expect(view.result.current.draft).toBeUndefined();
    expect(JSON.parse(read('sessions', 'sessionPlanDrafts')!)).toEqual({});
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: 's1',
      prompt: 'The user edited `C:\\s1\\plan.md`. Reread it before continuing, adapt remaining work, and preserve their edits.',
      mode: 'immediate',
    });
    expect(JSON.parse(read('sessions', 'sessionPlanNotices')!)).toEqual({});
  });

  it('retains edits and surfaces failures rather than claiming a successful save', async () => {
    saveSessionPlan.mockRejectedValue(new Error('changed on disk'));
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('unsaved'));
    await act(async () => { await view.result.current.save(); });
    expect(view.result.current.failed).toBe('changed on disk');
    expect(view.result.current.draft?.content).toBe('unsaved');
    expect(view.result.current.plan).toEqual(original);
    expect(view.result.current.saving).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not let a save overwrite the selected session after switching', async () => {
    let answer!: (value: SessionPlan) => void;
    saveSessionPlan.mockReturnValue(new Promise<SessionPlan>((resolve) => { answer = resolve; }));
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Saved'));
    act(() => { void view.result.current.save(); });
    view.rerender({ id: 's2' });
    sessionPlan.mockResolvedValue({ ...original, content: '# Other session' });
    await settle();
    await act(async () => answer({ ...original, content: '# Saved', revision: 'r2' }));
    expect(view.result.current.plan?.content).toBe('# Other session');
    expect(view.result.current.draft).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: 's1', prompt: expect.stringContaining('`C:\\s1\\plan.md`'), mode: 'immediate',
    });
  });

  it('reports read and watch failures separately without losing an existing plan', async () => {
    watchSessionPlan.mockImplementation((id) => id ? Promise.reject(new Error('watch unavailable')) : Promise.resolve());
    const view = watching();
    await settle();
    expect(view.result.current.plan).toEqual(original);
    expect(view.result.current.failed).toContain('watch unavailable');
    sessionPlan.mockRejectedValue(new Error('read denied'));
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.failed).toBe('read denied');
    expect(view.result.current.plan).toEqual(original);
  });

  it('surfaces asynchronous watcher failure and cancels pending refreshes when unmounted', async () => {
    const view = watching();
    await settle();
    emit('s1', 'session.plan_file_changed', { failed: 'watch stopped' });
    expect(view.result.current.failed).toBe('watch stopped');
    sessionPlan.mockClear();
    emit('s1');
    view.unmount();
    await act(async () => vi.advanceTimersByTime(150));
    expect(sessionPlan).not.toHaveBeenCalled();
  });

  it('restores only valid saved drafts', async () => {
    save('sessions', 'sessionPlanDrafts', JSON.stringify({ s1: { content: 'restored', revision: 'r1' }, invalid: 12 }));
    const view = watching();
    await settle();
    expect(view.result.current.draft?.content).toBe('restored');
    expect(JSON.parse(read('sessions', 'sessionPlanDrafts')!)).not.toHaveProperty('invalid');
  });

  it('includes compact changed-section hints when the sidecar provides them', async () => {
    saveSessionPlan.mockResolvedValue({
      ...original, content: '# Saved', revision: 'r2', changedSections: 'Implementation > Tests: L42-44',
    });
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Saved'));
    await act(async () => { await view.result.current.save(); });

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: 's1',
      prompt: 'The user edited `C:\\s1\\plan.md`. Changed: Implementation > Tests: L42-44. Reread those sections and any needed context before continuing, adapt remaining work, and preserve their edits.',
      mode: 'immediate',
    });
  });

  it('sends nothing for unchanged edits or an edit that was discarded', async () => {
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    await act(async () => { await view.result.current.save(); });
    expect(saveSessionPlan).not.toHaveBeenCalled();
    act(() => view.result.current.change('unsaved'));
    act(() => view.result.current.discard());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('waits for a successful disk save before sending and rejects duplicate saves', async () => {
    let answer!: (value: SessionPlan) => void;
    saveSessionPlan.mockReturnValue(new Promise<SessionPlan>((resolve) => { answer = resolve; }));
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Saved'));
    act(() => {
      void view.result.current.save();
      void view.result.current.save();
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(saveSessionPlan).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ...original, content: '# Saved', revision: 'r2' }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a saved plan saved when notification fails, preserves the notice across restarts, and retries without resaving', async () => {
    sendMessage.mockRejectedValue(new Error('session unavailable'));
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Saved'));
    await act(async () => { await view.result.current.save(); });
    expect(view.result.current.plan?.content).toBe('# Saved');
    expect(view.result.current.draft).toBeUndefined();
    expect(view.result.current.failed).toBeFalsy();
    expect(view.result.current.notificationFailed).toContain('session unavailable');
    expect(JSON.parse(read('sessions', 'sessionPlanNotices')!)).toHaveProperty('s1');

    sessionPlan.mockResolvedValue({ ...original, content: '# Saved', revision: 'r2' });
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.notificationFailed).toContain('session unavailable');
    view.unmount();
    const next = watching();
    await settle();
    expect(next.result.current.notificationFailed).toContain('agent has not been notified');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    sendMessage.mockResolvedValue({ messageId: 'retry', queued: false });
    await act(async () => { await next.result.current.retryNotification(); });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(saveSessionPlan).toHaveBeenCalledTimes(1);
    expect(next.result.current.notificationFailed).toBeUndefined();
    expect(JSON.parse(read('sessions', 'sessionPlanNotices')!)).toEqual({});
  });

  it('requests a whole-plan reread when a newer save follows an undelivered edit', async () => {
    sendMessage.mockRejectedValueOnce(new Error('offline'));
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Saved'));
    await act(async () => { await view.result.current.save(); });
    saveSessionPlan.mockResolvedValue({
      ...original, content: '# Second edit', revision: 'r3', changedSections: 'Deployment: L100',
    });
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Second edit'));
    await act(async () => { await view.result.current.save(); });
    expect(sendMessage.mock.lastCall?.[0].prompt).toBe(
      'The user edited `C:\\s1\\plan.md`. Reread it before continuing, adapt remaining work, and preserve their edits.',
    );
    expect(view.result.current.notificationFailed).toBeUndefined();
  });

  it('restores only valid pending notices and uses a whole-plan reread on retry', async () => {
    save('sessions', 'sessionPlanNotices', JSON.stringify({
      s1: { path: 'C:\\s1\\plan.md', prompt: 'old line ranges' }, invalid: { path: 42, prompt: false },
    }));
    const view = watching();
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(view.result.current.notificationFailed).toBeTruthy();
    expect(JSON.parse(read('sessions', 'sessionPlanNotices')!)).not.toHaveProperty('invalid');
    await act(async () => { await view.result.current.retryNotification(); });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: 's1',
      prompt: 'The user edited `C:\\s1\\plan.md`. Reread it before continuing, adapt remaining work, and preserve their edits.',
      mode: 'immediate',
    });
  });

  it('keeps a notification failure with its owning session after the reader switches away', async () => {
    let reject!: (reason: Error) => void;
    sendMessage.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const view = watching();
    await settle();
    act(() => view.result.current.edit());
    act(() => view.result.current.change('# Saved'));
    act(() => { void view.result.current.save(); });
    await settle();
    expect(view.result.current.notifying).toBe(true);
    view.rerender({ id: 's2' });
    await settle();
    await act(async () => reject(new Error('original session offline')));
    expect(view.result.current.notificationFailed).toBeUndefined();
    expect(view.result.current.failed).toBeFalsy();
    view.rerender({ id: 's1' });
    await settle();
    expect(view.result.current.notificationFailed).toContain('original session offline');
  });

  it('does not send duplicate retries while a notification is already being delivered', async () => {
    save('sessions', 'sessionPlanNotices', JSON.stringify({
      s1: { path: original.path, prompt: 'pending' },
    }));
    let answer!: (value: { messageId: string; queued: boolean }) => void;
    sendMessage.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const view = watching();
    await settle();
    act(() => {
      void view.result.current.retryNotification();
      void view.result.current.retryNotification();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(view.result.current.notifying).toBe(true);
    await act(async () => answer({ messageId: 'retry', queued: false }));
    expect(view.result.current.notificationFailed).toBeUndefined();
    expect(view.result.current.notifying).toBe(false);
  });
});
