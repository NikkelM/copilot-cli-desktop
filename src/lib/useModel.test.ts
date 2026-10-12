// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelChoice } from '../../shared/protocol';

const listModels = vi.fn();
const sessionModel = vi.fn();
const setSessionModel = vi.fn();

vi.mock('./sidecar', () => ({
  listModels: () => listModels(),
  sessionModel: (id: string) => sessionModel(id),
  setSessionModel: (...args: unknown[]) => setSessionModel(...args),
}));

const catalogue: ModelChoice[] = [
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    reasoningEfforts: ['max'],
    contexts: [{ tier: 'default', maxPromptTokens: 200_000 }],
    needsAgreement: false,
  },
];

/** paths differ per test, and the module holds the in-flight fetch between calls. */
async function loadUseModel() {
  vi.resetModules();
  return (await import('./useModel')).useModel;
}

beforeEach(() => {
  localStorage.clear();
  listModels.mockReset().mockResolvedValue(catalogue);
  sessionModel.mockReset().mockResolvedValue(null);
  setSessionModel.mockReset().mockResolvedValue(undefined);
});

describe('useModel', () => {
  it('reads what a session runs on', async () => {
    sessionModel.mockResolvedValue({ model: 'claude-opus-5', reasoningEffort: 'max' });
    const useModel = await loadUseModel();

    const { result } = renderHook(() => useModel('s1', () => {}));

    await waitFor(() => expect(result.current.current).toMatchObject({ model: 'claude-opus-5' }));
  });

  // Listing models starts the shared server, which is the one thing this app will not spend
  // on something nobody asked for.
  it('asks the runtime for nothing on its own', async () => {
    const useModel = await loadUseModel();

    renderHook(() => useModel('s1', () => {}));

    expect(listModels).not.toHaveBeenCalled();
  });

  it('fetches the catalogue once however often it is asked for', async () => {
    const useModel = await loadUseModel();
    const { result } = renderHook(() => useModel('s1', () => {}));

    act(() => result.current.refresh());
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.models).toHaveLength(1));

    expect(listModels).toHaveBeenCalledTimes(1);
  });

  describe('remembering the catalogue', () => {
    // A session's log names its model without saying how large its context is, so without a
    // remembered list the header cannot say how much room a session has until the picker is
    // opened.
    it('has the list before any fetch when it was seen in an earlier run', async () => {
      localStorage.setItem('copilot-desktop.models', JSON.stringify(catalogue));
      const useModel = await loadUseModel();

      const { result } = renderHook(() => useModel('s1', () => {}));

      expect(result.current.models).toHaveLength(1);
      expect(listModels).not.toHaveBeenCalled();
    });

    it('remembers what it fetched', async () => {
      const useModel = await loadUseModel();
      const { result } = renderHook(() => useModel('s1', () => {}));

      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.models).toHaveLength(1));

      expect(JSON.parse(localStorage.getItem('copilot-desktop.models')!)).toEqual(catalogue);
    });

    // What is stored outlives the code that stored it: an entry written before the
    // catalogue carried context sizes crashed the header when it was read back.
    it('ignores a remembered entry from an older shape', async () => {
      localStorage.setItem(
        'copilot-desktop.models',
        JSON.stringify([{ id: 'claude-opus-5', name: 'Claude Opus 5', reasoningEfforts: [], longContext: true }]),
      );
      const useModel = await loadUseModel();

      const { result } = renderHook(() => useModel('s1', () => {}));

      expect(result.current.models).toBeNull();
    });

    it('ignores a remembered list with one unusable entry among good ones', async () => {
      localStorage.setItem('copilot-desktop.models', JSON.stringify([...catalogue, { id: 'broken' }]));
      const useModel = await loadUseModel();

      const { result } = renderHook(() => useModel('s1', () => {}));

      expect(result.current.models).toBeNull();
    });
    it('ignores a remembered entry it cannot read', async () => {
      localStorage.setItem('copilot-desktop.models', 'not json');
      const useModel = await loadUseModel();

      const { result } = renderHook(() => useModel('s1', () => {}));

      expect(result.current.models).toBeNull();
    });
  });

  it('reports a catalogue it could not fetch', async () => {
    listModels.mockRejectedValue(new Error('runtime is not running'));
    const useModel = await loadUseModel();
    const { result } = renderHook(() => useModel('s1', () => {}));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.failed).toContain('runtime is not running'));
  });

  // A failure that is remembered can never be recovered from without restarting the app.
  it('tries again after a failure', async () => {
    listModels.mockRejectedValueOnce(new Error('not running'));
    const useModel = await loadUseModel();
    const { result } = renderHook(() => useModel('s1', () => {}));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.failed).not.toBeNull());
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.models).toHaveLength(1));
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  describe('changing the model', () => {
    it('tells the runtime what was chosen', async () => {
      const useModel = await loadUseModel();
      const { result } = renderHook(() => useModel('s1', () => {}));

      act(() => result.current.choose({ model: 'gpt-5.4', reasoningEffort: 'high', contextTier: 'long_context' }));

      expect(setSessionModel).toHaveBeenCalledWith('s1', 'gpt-5.4', 'high', 'long_context');
    });

    // Switching resumes the session, which takes seconds; the header should not sit on the
    // old answer for all of them.
    it('shows the choice before the runtime confirms it', async () => {
      const useModel = await loadUseModel();
      const { result } = renderHook(() => useModel('s1', () => {}));

      act(() => result.current.choose({ model: 'gpt-5.4', reasoningEffort: 'high' }));

      expect(result.current.current).toMatchObject({ model: 'gpt-5.4', reasoningEffort: 'high' });
    });

    it('reports a change the runtime refused', async () => {
      setSessionModel.mockRejectedValue(new Error('no such model'));
      const onError = vi.fn();
      const useModel = await loadUseModel();
      const { result } = renderHook(() => useModel('s1', onError));

      act(() => result.current.choose({ model: 'nonsense' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('no such model')));
    });
  });

  // Every resume reports the model, as does a switch made from a terminal.
  it('follows a change the runtime reports', async () => {
    const useModel = await loadUseModel();
    const { result } = renderHook(() => useModel('s1', () => {}));

    act(() =>
      result.current.observe({
        type: 'session.model_change',
        data: { newModel: 'grok-4.6', reasoningEffort: 'high', contextTier: 'long_context' },
      } as never),
    );

    expect(result.current.current).toEqual({
      model: 'grok-4.6',
      reasoningEffort: 'high',
      contextTier: 'long_context',
    });
  });

  // A delegated run announces the model it was given exactly as the session does. Four
  // starting at once put a small model, and the smaller context with it, into the header.
  it('ignores the model a delegated run reports', async () => {
    sessionModel.mockResolvedValue({ model: 'claude-opus-5', reasoningEffort: 'max', contextTier: 'long_context' });
    const useModel = await loadUseModel();
    const { result } = renderHook(() => useModel('s1', () => {}));
    await waitFor(() => expect(result.current.current).not.toBeUndefined());

    act(() =>
      result.current.observe({
        type: 'session.model_change',
        agentId: 'a1',
        data: { newModel: 'gpt-5.4-mini', reasoningEffort: 'low', contextTier: 'default' },
      } as never),
    );

    expect(result.current.current).toEqual({
      model: 'claude-opus-5',
      reasoningEffort: 'max',
      contextTier: 'long_context',
    });
  });

  it('ignores an event that is not about the model', async () => {
    sessionModel.mockResolvedValue({ model: 'claude-opus-5' });
    const useModel = await loadUseModel();
    const { result } = renderHook(() => useModel('s1', () => {}));
    await waitFor(() => expect(result.current.current).not.toBeUndefined());

    act(() => result.current.observe({ type: 'user.message', data: { content: 'hello' } } as never));

    expect(result.current.current).toMatchObject({ model: 'claude-opus-5' });
  });
});
