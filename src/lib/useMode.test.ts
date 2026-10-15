// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMode, TranscriptEvent } from '../../shared/protocol';

import { MODE_ORDER, useMode } from './useMode';

const { sessionMode, setSessionMode } = vi.hoisted(() => ({
  sessionMode: vi.fn(),
  setSessionMode: vi.fn(),
}));

vi.mock('./sidecar', () => ({ sessionMode, setSessionMode }));

const changed = (newMode: string) =>
  ({ type: 'session.mode_changed', data: { newMode, previousMode: 'interactive' } }) as unknown as TranscriptEvent;

describe('useMode', () => {
  beforeEach(() => {
    sessionMode.mockReset().mockResolvedValue('interactive');
    setSessionMode.mockReset().mockImplementation(async (_id: string, mode: SessionMode) => ({ mode }));
  });

  // Interactive is what a session runs in unless it says otherwise, so there is no
  // "not yet known" to show while the log is being read.
  it('starts a session off as interactive', () => {
    const { result } = renderHook(() => useMode('s1', () => {}));

    expect(result.current.mode).toBe('interactive');
  });

  it('reads the mode a session was left in', async () => {
    sessionMode.mockResolvedValue('autopilot');
    const { result } = renderHook(() => useMode('s1', () => {}));

    await waitFor(() => expect(result.current.mode).toBe('autopilot'));
    expect(sessionMode).toHaveBeenCalledWith('s1');
  });

  it('asks for nothing without a session', () => {
    renderHook(() => useMode(null, () => {}));

    expect(sessionMode).not.toHaveBeenCalled();
  });

  // Plenty of events carry a `newMode`-shaped payload without being a mode change.
  it('ignores an event that is not a mode change', async () => {
    const { result } = renderHook(() => useMode('s1', () => {}));
    await waitFor(() => expect(sessionMode).toHaveBeenCalled());

    act(() =>
      result.current.observe({
        type: 'session.model_changed',
        data: { newMode: 'autopilot' },
      } as unknown as TranscriptEvent),
    );

    expect(result.current.mode).toBe('interactive');
  });

  /**
   * A read that lands after the reader has moved on would otherwise label the session they
   * are looking at with the mode of the one they left.
   */
  it('ignores a read that arrives after the reader moved on', async () => {
    let answer: (mode: string) => void = () => {};
    sessionMode.mockImplementationOnce(() => new Promise<string>((resolve) => (answer = resolve)));

    const { result, rerender } = renderHook(({ id }) => useMode(id, () => {}), {
      initialProps: { id: 's1' as string | null },
    });
    rerender({ id: 's2' });
    act(() => answer('autopilot'));

    await waitFor(() => expect(result.current.mode).toBe('interactive'));
  });

  // The same, for a switch: the answer belongs to the session it was asked about.
  it('ignores a switch that lands after the reader moved on', async () => {
    let answer: (result: { mode: SessionMode }) => void = () => {};
    setSessionMode.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const { result, rerender } = renderHook(({ id }) => useMode(id, () => {}), {
      initialProps: { id: 's1' as string | null },
    });
    await waitFor(() => expect(sessionMode).toHaveBeenCalledWith('s1'));

    act(() => result.current.choose('plan'));
    rerender({ id: 's2' });
    await waitFor(() => expect(sessionMode).toHaveBeenCalledWith('s2'));
    await act(async () => answer({ mode: 'autopilot' }));

    expect(result.current.mode).toBe('interactive');
  });

  it('walks interactive, plan, autopilot and round again', async () => {
    const { result } = renderHook(() => useMode('s1', () => {}));
    await waitFor(() => expect(sessionMode).toHaveBeenCalled());

    for (const expected of ['plan', 'autopilot', 'interactive'] as const) {
      await act(async () => result.current.cycle());
      await waitFor(() => expect(result.current.mode).toBe(expected));
    }
  });

  it('puts the session into a mode outright', async () => {
    const { result } = renderHook(() => useMode('s1', () => {}));

    await act(async () => result.current.choose('plan'));

    expect(setSessionMode).toHaveBeenCalledWith('s1', 'plan');
    await waitFor(() => expect(result.current.mode).toBe('plan'));
  });

  /**
   * A switch can be refused, or held up on a confirmation this app does not answer. The
   * runtime's answer is what the reader is shown, so the indicator cannot claim a mode the
   * session is not in.
   */
  it('corrects itself when the switch did not take', async () => {
    setSessionMode.mockResolvedValue({ mode: 'interactive' });
    const { result } = renderHook(() => useMode('s1', () => {}));

    await act(async () => result.current.choose('plan'));

    await waitFor(() => expect(result.current.mode).toBe('interactive'));
  });

  // Entering plan mode can switch the model, which the reader should not find out later.
  it('passes on what the runtime said about the switch', async () => {
    setSessionMode.mockResolvedValue({ mode: 'plan', notice: 'Plan model set to Auto' });
    const said: string[] = [];
    const { result } = renderHook(() => useMode('s1', (m) => said.push(m)));

    await act(async () => result.current.choose('plan'));

    await waitFor(() => expect(said).toEqual(['Plan model set to Auto']));
  });

  it('reports a switch that could not be made', async () => {
    setSessionMode.mockRejectedValue(new Error('session is gone'));
    const said: string[] = [];
    const { result } = renderHook(() => useMode('s1', (m) => said.push(m)));

    await act(async () => result.current.choose('plan'));

    await waitFor(() => expect(said.join()).toContain('session is gone'));
  });

  it('does nothing without a session to change', async () => {
    const { result } = renderHook(() => useMode(null, () => {}));

    await act(async () => result.current.cycle());

    expect(setSessionMode).not.toHaveBeenCalled();
  });

  // The two ways a mode changes without this app asking: a slash command, and a terminal
  // attached to the same session.
  it('follows a change the runtime reports', async () => {
    const { result } = renderHook(() => useMode('s1', () => {}));

    act(() => result.current.observe(changed('autopilot')));

    await waitFor(() => expect(result.current.mode).toBe('autopilot'));
  });

  it('ignores an event about something else', async () => {
    const { result } = renderHook(() => useMode('s1', () => {}));

    act(() => result.current.observe({ type: 'session.idle', data: {} } as unknown as TranscriptEvent));

    expect(result.current.mode).toBe('interactive');
  });

  // `shell` is a mode the SDK records without it being a session mode, so it must not be
  // shown as one - there would be no way back to it through the cycle.
  it('ignores a mode it does not know', async () => {
    const { result } = renderHook(() => useMode('s1', () => {}));

    act(() => result.current.observe(changed('plan')));
    await waitFor(() => expect(result.current.mode).toBe('plan'));
    act(() => result.current.observe(changed('shell')));

    expect(result.current.mode).toBe('plan');
  });

  it('starts over when the reader opens another session', async () => {
    sessionMode.mockResolvedValueOnce('autopilot');
    const { result, rerender } = renderHook(({ id }) => useMode(id, () => {}), {
      initialProps: { id: 's1' as string | null },
    });
    await waitFor(() => expect(result.current.mode).toBe('autopilot'));

    sessionMode.mockResolvedValueOnce('plan');
    rerender({ id: 's2' });

    await waitFor(() => expect(result.current.mode).toBe('plan'));
  });

  // The default is already on screen, and a session that cannot say what mode it is in is
  // not worth interrupting the reader over.
  it('says nothing when the mode cannot be read', async () => {
    sessionMode.mockRejectedValue(new Error('no log'));
    const said: string[] = [];
    const { result } = renderHook(() => useMode('s1', (m) => said.push(m)));

    await waitFor(() => expect(sessionMode).toHaveBeenCalled());
    expect(result.current.mode).toBe('interactive');
    expect(said).toEqual([]);
  });

  it('offers the three modes in the order the CLI walks them', () => {
    expect(MODE_ORDER).toEqual(['interactive', 'plan', 'autopilot']);
  });

  /**
   * The log is read when a session is opened, and resuming it emits a mode change while
   * that read is still in flight. Without the guard the stale read lands last and puts the
   * indicator back to whatever the log happened to say.
   */
  it('does not let a slow log read undo a change that arrived meanwhile', async () => {
    let answer: (mode: string) => void = () => {};
    sessionMode.mockImplementationOnce(() => new Promise<string>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useMode('s1', () => {}));

    act(() => result.current.observe(changed('autopilot')));
    act(() => answer('interactive'));

    await waitFor(() => expect(result.current.mode).toBe('autopilot'));
  });

  // The same race, with the reader rather than the runtime as the one being overruled.
  it('does not let a slow log read undo a mode the reader chose', async () => {
    let answer: (mode: string) => void = () => {};
    sessionMode.mockImplementationOnce(() => new Promise<string>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useMode('s1', () => {}));

    await act(async () => result.current.choose('plan'));
    act(() => answer('interactive'));

    await waitFor(() => expect(result.current.mode).toBe('plan'));
  });
});

/**
 * App subscribes to the runtime once, when it starts, and holds whatever callbacks it was
 * given then for the rest of the run. One that changes identity when the reader opens
 * another session is therefore one the subscription will never be handed again: it goes on
 * answering for whichever session was open at the moment the app started, which was none.
 *
 * That is how the live half of the todo list came to have never worked. The rule is cheap to
 * state and cheap to check, so it is checked here rather than left to be remembered.
 */describe('the identity App subscribes with', () => {
  beforeEach(() => {
    sessionMode.mockReset().mockResolvedValue('interactive');
  });

  it('survives the reader moving to another session', () => {
    const view = renderHook(({ id }: { id: string }) => useMode(id, () => {}), { initialProps: { id: 's1' } });
    const { observe } = view.result.current;

    view.rerender({ id: 's2' });

    expect(view.result.current.observe).toBe(observe);
  });
});