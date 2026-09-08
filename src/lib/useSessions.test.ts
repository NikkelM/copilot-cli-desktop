// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary, TranscriptEvent } from '../../shared/protocol';
import { useSessions } from './useSessions';

const { listSessions, runtimeStatus } = vi.hoisted(() => ({
  listSessions: vi.fn(),
  runtimeStatus: vi.fn(),
}));

vi.mock('./sidecar', () => ({ listSessions, runtimeStatus }));

function summary(sessionId: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    title: sessionId,
    cwd: null,
    repository: null,
    branch: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    preview: `preview ${sessionId}`,
    loaded: false,
    ...over,
  };
}

function said(content: string): TranscriptEvent {
  return { type: 'assistant.message', timestamp: '2026-01-02T00:00:01.000Z', data: { content } } as TranscriptEvent;
}

/** Mount, and wait for the first fetch to land so a test does not assert on an empty list. */
async function listed(onError = vi.fn()) {
  const hook = renderHook(() => useSessions(onError));
  await waitFor(() => expect(hook.result.current.all.length).toBeGreaterThan(0));
  return hook;
}

describe('useSessions', () => {
  beforeEach(() => {
    listSessions.mockReset().mockResolvedValue({ sessions: [summary('s1'), summary('s2')] });
    runtimeStatus.mockReset().mockResolvedValue({ maxLoadedSessions: 3 });
  });

  it('reads the list once it is mounted', async () => {
    const { result } = await listed();
    expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('asks how many sessions may be resident, so the sidebar can say', async () => {
    const { result } = await listed();
    await waitFor(() => expect(result.current.maxLoaded).toBe(3));
  });

  it('reports a failed read rather than showing an empty sidebar silently', async () => {
    const onError = vi.fn();
    listSessions.mockRejectedValue(new Error('no store'));
    renderHook(() => useSessions(onError));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('no store')));
  });

  it('finds nothing for a session it does not carry', async () => {
    const { result } = await listed();
    expect(result.current.find('nope')).toBeNull();
    expect(result.current.find(null)).toBeNull();
  });

  describe('previews taken from live events', () => {
    it('shows what a session just said, ahead of the database', async () => {
      const { result } = await listed();

      act(() => result.current.observe('s1', said('all done')));

      expect(result.current.find('s1')?.preview).toBe('all done');
      expect(result.current.find('s2')?.preview).toBe('preview s2');
    });

    /**
     * The reason the override is kept outside the fetched list. The store changes on every
     * turn of every running session, so a refetch lands moments after the event, carrying
     * the preview the lagging turns table still holds.
     */
    it('keeps the live preview when the list is read again', async () => {
      const { result } = await listed();
      act(() => result.current.observe('s1', said('all done')));

      await act(async () => void (await result.current.refresh()));

      expect(result.current.find('s1')?.preview).toBe('all done');
    });

    it('gives up the override once the session is let go', async () => {
      const { result } = await listed();
      act(() => result.current.observe('s1', said('all done')));

      act(() => result.current.observeLoaded('s1', false));
      await act(async () => void (await result.current.refresh()));

      expect(result.current.find('s1')?.preview).toBe('preview s1');
    });

    it('ignores an event that says nothing', async () => {
      const { result } = await listed();

      act(() => result.current.observe('s1', { type: 'session.idle', timestamp: '', data: {} } as TranscriptEvent));

      expect(result.current.find('s1')?.preview).toBe('preview s1');
    });
  });

  describe('the active group', () => {
    it('puts a session that wakes at the top', async () => {
      const { result } = await listed();

      act(() => result.current.observeLoaded('s2', true));

      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s2', 's1']);
      expect(result.current.find('s2')?.loaded).toBe(true);
    });

    /** Sending a message must not shuffle the sidebar under the reader's cursor. */
    it('leaves an already active session where it is', async () => {
      const { result } = await listed();
      act(() => result.current.observeLoaded('s1', true));
      act(() => result.current.observeLoaded('s2', true));
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s2', 's1']);

      act(() => result.current.observeLoaded('s2', true));

      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    });

    it('drops a session from the group when it is let go', async () => {
      const { result } = await listed();
      act(() => result.current.observeLoaded('s2', true));

      act(() => result.current.observeLoaded('s2', false));

      expect(result.current.find('s2')?.loaded).toBe(false);
      expect(result.current.all.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    });
  });
});
