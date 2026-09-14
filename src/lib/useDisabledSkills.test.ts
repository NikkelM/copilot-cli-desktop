// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDisabledSkills } from './useDisabledSkills';

const disabledSkills = vi.fn();
const setSkillEnabled = vi.fn();

vi.mock('./sidecar', () => ({
  disabledSkills: (sessionId: string) => disabledSkills(sessionId),
  setSkillEnabled: (sessionId: string, name: string, enabled: boolean) => setSkillEnabled(sessionId, name, enabled),
}));

/** A promise that can be settled from the test, for checking what happens mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  disabledSkills.mockReset().mockResolvedValue({ disabled: [] });
  setSkillEnabled.mockReset().mockResolvedValue({ disabled: [] });
});

describe('useDisabledSkills', () => {
  it('reads what the session has switched off when it is selected', async () => {
    disabledSkills.mockResolvedValue({ disabled: ['agent-creator'] });

    const { result } = renderHook(() => useDisabledSkills('s1'));

    await waitFor(() => expect(result.current.disabled).toEqual(['agent-creator']));
    expect(disabledSkills).toHaveBeenCalledWith('s1');
  });

  it('asks nothing when there is no session', () => {
    renderHook(() => useDisabledSkills(null));

    expect(disabledSkills).not.toHaveBeenCalled();
  });

  it('switches a skill off', async () => {
    setSkillEnabled.mockResolvedValue({ disabled: ['agent-creator'] });
    const { result } = renderHook(() => useDisabledSkills('s1'));
    await waitFor(() => expect(disabledSkills).toHaveBeenCalled());

    await act(async () => {
      await result.current.toggle('agent-creator', false);
    });

    expect(setSkillEnabled).toHaveBeenCalledWith('s1', 'agent-creator', false);
    expect(result.current.disabled).toEqual(['agent-creator']);
  });

  // The sidecar answers with everything that is off, not with the one that changed, so the
  // reply replaces what is held rather than being added to it.
  it('takes the whole set back, not the change', async () => {
    disabledSkills.mockResolvedValue({ disabled: ['a', 'b'] });
    setSkillEnabled.mockResolvedValue({ disabled: ['b'] });
    const { result } = renderHook(() => useDisabledSkills('s1'));
    await waitFor(() => expect(result.current.disabled).toEqual(['a', 'b']));

    await act(async () => {
      await result.current.toggle('a', true);
    });

    expect(result.current.disabled).toEqual(['b']);
  });

  it('changes nothing when there is no session to change it for', async () => {
    const { result } = renderHook(() => useDisabledSkills(null));

    await act(async () => {
      await result.current.toggle('agent-creator', false);
    });

    expect(setSkillEnabled).not.toHaveBeenCalled();
  });

  // One session's choices must never be shown against another's.
  it('forgets the last session when another is selected', async () => {
    disabledSkills.mockResolvedValue({ disabled: ['agent-creator'] });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDisabledSkills(id), {
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.disabled).toEqual(['agent-creator']));

    disabledSkills.mockResolvedValue({ disabled: [] });
    rerender({ id: 's2' });

    expect(result.current.disabled).toEqual([]);
  });

  it('lets a slow answer for an old session fall on the floor', async () => {
    const slow = deferred<{ disabled: string[] }>();
    disabledSkills.mockReturnValueOnce(slow.promise).mockResolvedValue({ disabled: ['for-s2'] });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDisabledSkills(id), {
      initialProps: { id: 's1' },
    });

    rerender({ id: 's2' });
    await waitFor(() => expect(result.current.disabled).toEqual(['for-s2']));
    await act(async () => {
      slow.resolve({ disabled: ['for-s1'] });
    });

    expect(result.current.disabled).toEqual(['for-s2']);
  });

  it('says so when the set cannot be read', async () => {
    disabledSkills.mockRejectedValue(new Error('no store'));

    const { result } = renderHook(() => useDisabledSkills('s1'));

    await waitFor(() => expect(result.current.failed).toContain('no store'));
  });

  it('says so when a switch does not take', async () => {
    setSkillEnabled.mockRejectedValue(new Error('would not write'));
    const { result } = renderHook(() => useDisabledSkills('s1'));
    await waitFor(() => expect(disabledSkills).toHaveBeenCalled());

    await act(async () => {
      await result.current.toggle('agent-creator', false);
    });

    expect(result.current.failed).toContain('would not write');
  });
});
