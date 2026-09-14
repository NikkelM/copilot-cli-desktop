// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgent } from './useAgent';
import type { AgentSummary, TranscriptEvent } from '../../shared/protocol';

const listAgents = vi.fn();
const sessionAgent = vi.fn();
const selectAgent = vi.fn();
const deselectAgent = vi.fn();

vi.mock('./sidecar', () => ({
  listAgents: (cwd?: string) => listAgents(cwd),
  sessionAgent: (id: string) => sessionAgent(id),
  selectAgent: (id: string, name: string) => selectAgent(id, name),
  deselectAgent: (id: string) => deselectAgent(id),
}));

const audit: AgentSummary = {
  id: 'deep-audit',
  name: 'deep-audit',
  displayName: 'Deep Audit',
  description: 'Audits things',
  source: 'user',
  userInvocable: true,
};

const spawned: AgentSummary = {
  id: 'spawned-only',
  name: 'spawned-only',
  displayName: 'Spawned Only',
  description: 'Not for people',
  source: 'user',
  userInvocable: false,
};

const event = (type: string, data: Record<string, unknown> = {}): TranscriptEvent =>
  ({ type, data }) as TranscriptEvent;

beforeEach(() => {
  listAgents.mockReset().mockResolvedValue([audit, spawned]);
  sessionAgent.mockReset().mockResolvedValue(null);
  selectAgent.mockReset().mockResolvedValue(undefined);
  deselectAgent.mockReset().mockResolvedValue(undefined);
});

describe('useAgent', () => {
  it('reads which agent a session is on', async () => {
    sessionAgent.mockResolvedValue({ name: 'deep-audit', displayName: 'Deep Audit' });

    const { result } = renderHook(() => useAgent('s1', null, () => {}));

    await waitFor(() => expect(result.current.current).toEqual({ name: 'deep-audit', displayName: 'Deep Audit' }));
  });

  /** Listing starts the shared server, which nothing does until somebody asks for it. */
  it('asks the runtime for nothing on its own', () => {
    renderHook(() => useAgent('s1', null, () => {}));

    expect(listAgents).not.toHaveBeenCalled();
  });

  /**
   * Not yet read and the default agent look the same to a reader, so they must not look the
   * same to the control: one holds its shape and the other names what it is.
   */
  it('says it does not know yet before the log has been read', () => {
    const { result } = renderHook(() => useAgent('s1', null, () => {}));

    expect(result.current.current).toBeUndefined();
  });

  it('forgets the last session while reading the next', async () => {
    sessionAgent.mockResolvedValue({ name: 'deep-audit', displayName: 'Deep Audit' });
    const { result, rerender } = renderHook(({ id }) => useAgent(id, null, () => {}), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.current).not.toBeUndefined());

    let resolve: (value: unknown) => void = () => {};
    sessionAgent.mockReturnValue(new Promise((r) => (resolve = r)));
    rerender({ id: 's2' });

    expect(result.current.current).toBeUndefined();
    await act(async () => resolve(null));
  });

  it('offers only the agents a reader may pick', async () => {
    const { result } = renderHook(() => useAgent('s1', null, () => {}));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.agents).toEqual([audit]));
  });

  it('asks about the session directory, so a project sees its own agents', async () => {
    const { result } = renderHook(() => useAgent('s1', 'C:\\repo', () => {}));

    act(() => result.current.refresh());

    await waitFor(() => expect(listAgents).toHaveBeenCalledWith('C:\\repo'));
  });

  it('asks once however often the picker is opened', async () => {
    let resolve: (value: unknown) => void = () => {};
    listAgents.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useAgent('s1', null, () => {}));

    act(() => result.current.refresh());
    act(() => result.current.refresh());

    expect(listAgents).toHaveBeenCalledTimes(1);
    await act(async () => resolve([audit]));
  });

  /** What a project defines is part of the answer, so another project's answer is wrong. */
  it('drops what it knows when the session directory changes', async () => {
    const { result, rerender } = renderHook(({ cwd }) => useAgent('s1', cwd, () => {}), {
      initialProps: { cwd: 'C:\\one' },
    });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.agents).toEqual([audit]));

    rerender({ cwd: 'C:\\two' });

    expect(result.current.agents).toBeNull();
  });

  it('reports why the agents could not be listed', async () => {
    listAgents.mockRejectedValue(new Error('no runtime'));
    const { result } = renderHook(() => useAgent('s1', null, () => {}));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.failed).toContain('no runtime'));
  });

  describe('choosing', () => {
    it('puts the session on the agent it was given', async () => {
      const { result } = renderHook(() => useAgent('s1', null, () => {}));

      act(() => result.current.choose(audit));

      expect(selectAgent).toHaveBeenCalledWith('s1', 'deep-audit');
      await waitFor(() => expect(result.current.current).toEqual({ name: 'deep-audit', displayName: 'Deep Audit' }));
    });

    it('returns the session to the default when given nothing', async () => {
      sessionAgent.mockResolvedValue({ name: 'deep-audit', displayName: 'Deep Audit' });
      const { result } = renderHook(() => useAgent('s1', null, () => {}));
      await waitFor(() => expect(result.current.current).not.toBeUndefined());

      act(() => result.current.choose(null));

      expect(deselectAgent).toHaveBeenCalledWith('s1');
      expect(result.current.current).toBeNull();
    });

    /** Switching resumes the session, which takes seconds the header should not wait out. */
    it('shows the choice before the runtime confirms it', () => {
      let never: () => void = () => {};
      selectAgent.mockReturnValue(new Promise(() => (never = () => {})));
      const { result } = renderHook(() => useAgent('s1', null, () => {}));

      act(() => result.current.choose(audit));

      expect(result.current.current).toEqual({ name: 'deep-audit', displayName: 'Deep Audit' });
      never();
    });

    it('reports a choice the runtime refused', async () => {
      const onError = vi.fn();
      selectAgent.mockRejectedValue(new Error('gone'));
      const { result } = renderHook(() => useAgent('s1', null, onError));

      act(() => result.current.choose(audit));

      await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('gone')));
    });

    it('does nothing when no session is open', () => {
      const { result } = renderHook(() => useAgent(null, null, () => {}));

      act(() => result.current.choose(audit));

      expect(selectAgent).not.toHaveBeenCalled();
    });
  });

  describe('following the runtime', () => {
    it('takes an agent chosen somewhere else', () => {
      const { result } = renderHook(() => useAgent('s1', null, () => {}));

      act(() =>
        result.current.observe(event('subagent.selected', { agentName: 'other', agentDisplayName: 'Other' })),
      );

      expect(result.current.current).toEqual({ name: 'other', displayName: 'Other' });
    });

    it('falls back to the name when the runtime gives no display name', () => {
      const { result } = renderHook(() => useAgent('s1', null, () => {}));

      act(() => result.current.observe(event('subagent.selected', { agentName: 'other' })));

      expect(result.current.current).toEqual({ name: 'other', displayName: 'other' });
    });

    it('takes a return to the default', async () => {
      sessionAgent.mockResolvedValue({ name: 'deep-audit', displayName: 'Deep Audit' });
      const { result } = renderHook(() => useAgent('s1', null, () => {}));
      await waitFor(() => expect(result.current.current).not.toBeUndefined());

      act(() => result.current.observe(event('subagent.deselected')));

      expect(result.current.current).toBeNull();
    });

    it('ignores everything else the session says', async () => {
      sessionAgent.mockResolvedValue({ name: 'deep-audit', displayName: 'Deep Audit' });
      const { result } = renderHook(() => useAgent('s1', null, () => {}));
      await waitFor(() => expect(result.current.current).not.toBeUndefined());

      act(() => result.current.observe(event('session.idle')));

      expect(result.current.current).toEqual({ name: 'deep-audit', displayName: 'Deep Audit' });
    });
  });
});
