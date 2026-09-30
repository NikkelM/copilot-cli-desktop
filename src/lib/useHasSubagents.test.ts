// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionAgents = vi.fn();
vi.mock('./sidecar', () => ({ sessionAgents: (...args: unknown[]) => sessionAgents(...args) }));

const { useHasSubagents } = await import('./useHasSubagents');

const answer = (agents: number, truncated: boolean) => ({
  agents: Array.from({ length: agents }, (_, at) => ({ agentId: `a${at}` })),
  truncated,
  nextBefore: truncated ? 100 : null,
});

beforeEach(() => {
  sessionAgents.mockReset().mockResolvedValue(answer(0, false));
});

/**
 * Whether a session delegated anything, for the menu entry that lists them (#228).
 *
 * Only ever answered "none" when the whole log was read and held nothing. Anything less is
 * no answer, and the entry stays offered - greying one out wrongly would hide the feature
 * from exactly the session that needed it.
 */
describe('whether a session delegated anything', () => {
  it('says nothing about a session nobody asked about', () => {
    const { result } = renderHook(() => useHasSubagents());

    expect(result.current.hasNone('s1')).toBe(false);
  });

  it('asks the log about the session it was given', async () => {
    const { result } = renderHook(() => useHasSubagents());

    act(() => result.current.check('s1'));

    await waitFor(() => expect(sessionAgents).toHaveBeenCalledWith('s1', 1));
  });

  /** The whole log was read and held nothing, which is the one certain answer. */
  it('says none when the log was read to the end and held nothing', async () => {
    const { result } = renderHook(() => useHasSubagents());

    act(() => result.current.check('s1'));

    await waitFor(() => expect(result.current.hasNone('s1')).toBe(true));
  });

  it('says nothing about a session that delegated something', async () => {
    sessionAgents.mockResolvedValue(answer(1, false));
    const { result } = renderHook(() => useHasSubagents());

    act(() => result.current.check('s1'));

    await waitFor(() => expect(sessionAgents).toHaveBeenCalled());
    expect(result.current.hasNone('s1')).toBe(false);
  });

  /**
   * A read that stopped at its ceiling proves nothing: the log goes on past where it
   * looked, and the tasks are spread through it rather than gathered at the end.
   */
  it('says nothing when the log was too large to read to the end', async () => {
    sessionAgents.mockResolvedValue(answer(0, true));
    const { result } = renderHook(() => useHasSubagents());

    act(() => result.current.check('s1'));

    await waitFor(() => expect(sessionAgents).toHaveBeenCalled());
    expect(result.current.hasNone('s1')).toBe(false);
  });

  it('says nothing when the log could not be read', async () => {
    sessionAgents.mockRejectedValue(new Error('gone'));
    const { result } = renderHook(() => useHasSubagents());

    act(() => result.current.check('s1'));

    await waitFor(() => expect(sessionAgents).toHaveBeenCalled());
    expect(result.current.hasNone('s1')).toBe(false);
  });

  // Opening a menu twice should not read a log twice.
  it('asks once however often it is asked', async () => {
    const { result } = renderHook(() => useHasSubagents());

    act(() => result.current.check('s1'));
    await waitFor(() => expect(sessionAgents).toHaveBeenCalledTimes(1));
    act(() => result.current.check('s1'));

    expect(sessionAgents).toHaveBeenCalledTimes(1);
  });

  /** A log that could not be read is worth asking about again, since nothing was learnt. */
  it('asks again after a read that failed', async () => {
    sessionAgents.mockRejectedValue(new Error('gone'));
    const { result } = renderHook(() => useHasSubagents());
    act(() => result.current.check('s1'));
    await waitFor(() => expect(sessionAgents).toHaveBeenCalledTimes(1));

    act(() => result.current.check('s1'));

    await waitFor(() => expect(sessionAgents).toHaveBeenCalledTimes(2));
  });

  it('keeps one session answer apart from another', async () => {
    sessionAgents.mockResolvedValueOnce(answer(0, false)).mockResolvedValueOnce(answer(2, false));
    const { result } = renderHook(() => useHasSubagents());

    act(() => result.current.check('empty'));
    act(() => result.current.check('busy'));

    await waitFor(() => expect(result.current.hasNone('empty')).toBe(true));
    expect(result.current.hasNone('busy')).toBe(false);
  });
});
