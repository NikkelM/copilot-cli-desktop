// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionPrompt } from '../../shared/protocol';

const { sessionPrompts } = vi.hoisted(() => ({ sessionPrompts: vi.fn() }));
vi.mock('./sidecar', () => ({ sessionPrompts: (id: string) => sessionPrompts(id) }));

import { usePromptList } from './usePromptList';

const prompt = (text: string): SessionPrompt => ({ at: '2026-01-01T00:00:00.000Z', text });

beforeEach(() => {
  sessionPrompts.mockReset().mockResolvedValue([prompt('mine')]);
});

const watching = (sessionId: string | null = 's1', since = 1) =>
  renderHook(({ id, events }: { id: string | null; events: number }) => usePromptList(id, events), {
    initialProps: { id: sessionId, events: since },
  });

/**
 * The prompts of a session, read on demand (#96).
 *
 * The read is the slowest in the app - a second on the largest log here - which makes it the
 * one most likely to come back after the reader has moved on.
 */
describe('reading a session prompts', () => {
  it('asks for nothing until it is asked to', () => {
    watching();
    expect(sessionPrompts).not.toHaveBeenCalled();
  });

  it('reads the session it was asked about', async () => {
    const view = watching();

    act(() => view.result.current.load());

    await waitFor(() => expect(view.result.current.prompts).toHaveLength(1));
    expect(sessionPrompts).toHaveBeenCalledExactlyOnceWith('s1');
  });

  /** A second a time is too much to pay twice for an answer that has not changed. */
  it('reads once while the session has said nothing more', async () => {
    const view = watching();

    act(() => view.result.current.load());
    await waitFor(() => expect(view.result.current.prompts).toHaveLength(1));
    act(() => view.result.current.load());

    expect(sessionPrompts).toHaveBeenCalledOnce();
  });

  it('reads again once the session has said something', async () => {
    const view = watching('s1', 1);

    act(() => view.result.current.load());
    await waitFor(() => expect(view.result.current.prompts).toHaveLength(1));

    view.rerender({ id: 's1', events: 2 });
    act(() => view.result.current.load());

    await waitFor(() => expect(sessionPrompts).toHaveBeenCalledTimes(2));
  });

  /**
   * The whole reason this guard exists: another session's prompts shown as this one's would
   * be chosen from, and choosing resolves the moment against the open session's log - so a
   * pick from the wrong list jumps this session to wherever that moment happens to fall.
   */
  it('drops an answer that arrives after the reader has moved on', async () => {
    let answer: (prompts: SessionPrompt[]) => void = () => {};
    sessionPrompts.mockImplementation(() => new Promise<SessionPrompt[]>((resolve) => (answer = resolve)));
    const view = watching('s1');

    act(() => view.result.current.load());
    view.rerender({ id: 's2', events: 1 });
    await act(async () => {
      answer([prompt('from the session that was open before')]);
      await Promise.resolve();
    });

    expect(view.result.current.prompts).toBeNull();
  });

  it('drops a failure that arrives after the reader has moved on', async () => {
    let fail: (error: Error) => void = () => {};
    sessionPrompts.mockImplementation(() => new Promise<SessionPrompt[]>((_, reject) => (fail = reject)));
    const view = watching('s1');

    act(() => view.result.current.load());
    view.rerender({ id: 's2', events: 1 });
    await act(async () => {
      fail(new Error('the log is gone'));
      await Promise.resolve();
    });

    expect(view.result.current.failed).toBeNull();
  });

  it('says why it could not read one', async () => {
    sessionPrompts.mockRejectedValue(new Error('the log is gone'));
    const view = watching();

    act(() => view.result.current.load());

    await waitFor(() => expect(view.result.current.failed).toContain('the log is gone'));
  });

  /** A read that failed is not an answer, so it must not count as one already given. */
  it('tries again after a failure', async () => {
    sessionPrompts.mockRejectedValueOnce(new Error('busy'));
    const view = watching();

    act(() => view.result.current.load());
    await waitFor(() => expect(view.result.current.failed).toBeTruthy());
    act(() => view.result.current.load());

    await waitFor(() => expect(view.result.current.prompts).toHaveLength(1));
  });

  it('keeps none of it on moving to another session', async () => {
    const view = watching();

    act(() => view.result.current.load());
    await waitFor(() => expect(view.result.current.prompts).toHaveLength(1));
    act(() => view.result.current.went('2026-01-01T00:00:00.000Z'));

    view.rerender({ id: 's2', events: 1 });

    expect(view.result.current.prompts).toBeNull();
    expect(view.result.current.at).toBeNull();
  });
});
