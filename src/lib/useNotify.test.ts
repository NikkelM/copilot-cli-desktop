// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ActionPerformed } from '@tauri-apps/plugin-notification';

import { useNotify, type Wanted } from './useNotify';

const sendNotification = vi.fn();
const isPermissionGranted = vi.fn(() => Promise.resolve(true));
const requestPermission = vi.fn(() => Promise.resolve('granted'));
const opened = vi.fn();
const unregister = vi.fn(async () => {});
const onAction = vi.fn<(callback: (event: ActionPerformed) => void) => Promise<{ unregister: typeof unregister }>>();
const unminimize = vi.fn(async () => {});
const show = vi.fn(async () => {});
const setFocus = vi.fn(async () => {});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ unminimize, show, setFocus }),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...args),
  isPermissionGranted: () => isPermissionGranted(),
  requestPermission: () => requestPermission(),
  onAction: (callback: (event: ActionPerformed) => void) => onAction(callback),
}));

beforeEach(() => {
  sendNotification.mockReset();
  opened.mockReset();
  unregister.mockReset().mockResolvedValue(undefined);
  onAction.mockReset().mockResolvedValue({ unregister });
  unminimize.mockClear();
  show.mockClear();
  setFocus.mockClear();
  isPermissionGranted.mockReset().mockResolvedValue(true);
  requestPermission.mockReset().mockResolvedValue('granted');
});

const wants = (sessionId: string, mark: Wanted['mark'], title: string | null = 'Biomes'): Wanted => ({
  sessionId,
  mark,
  title,
});

/** Mounts with nothing owed, so the first pass has nothing to learn and the next one speaks. */
const start = () =>
  renderHook(({ wanted }: { wanted: Wanted[] }) => useNotify(wanted, opened), { initialProps: { wanted: [] as Wanted[] } });

const tap = (extra: Record<string, unknown> = { sessionId: 'a' }): ActionPerformed => ({
  actionId: 'tap',
  inputValue: null,
  notification: { id: 1, extra, groupSummary: false, data: {}, attachments: [] },
});

describe('opening the session a notification came from', () => {
  it('opens the payload session and restores and focuses the window', async () => {
    start();

    act(() => onAction.mock.calls[0]![0](tap({ sessionId: 'another-session' })));

    await waitFor(() => expect(setFocus).toHaveBeenCalledTimes(1));
    expect(opened).toHaveBeenCalledExactlyOnceWith('another-session');
    expect(unminimize).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(unminimize.mock.invocationCallOrder[0]).toBeLessThan(show.mock.invocationCallOrder[0]!);
    expect(show.mock.invocationCallOrder[0]).toBeLessThan(setFocus.mock.invocationCallOrder[0]!);
  });

  it.each([
    { ...tap(), actionId: 'dismiss' },
    { ...tap(), notification: null },
    tap({}),
    tap({ sessionId: 42 }),
    tap({ sessionId: '' }),
  ])('does not navigate for an unrelated action or missing session: %j', async (event) => {
    start();
    act(() => onAction.mock.calls[0]![0](event));
    await act(async () => {});
    expect(opened).not.toHaveBeenCalled();
    expect(setFocus).not.toHaveBeenCalled();
  });

  it('uses the latest callback without registering another listener', async () => {
    const next = vi.fn();
    const view = renderHook(({ open }) => useNotify([], open), { initialProps: { open: opened } });
    view.rerender({ open: next });

    act(() => onAction.mock.calls[0]![0](tap()));

    await waitFor(() => expect(next).toHaveBeenCalledWith('a'));
    expect(opened).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('unregisters when unmounted and ignores late callbacks', async () => {
    const view = start();
    await act(async () => {});
    view.unmount();

    act(() => onAction.mock.calls[0]![0](tap()));

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
  });

  it('cleans up late registration when unmounted and mounted again', async () => {
    const releases = [vi.fn(async () => {}), vi.fn(async () => {})];
    const pending: Array<() => void> = [];
    onAction.mockImplementation(() => new Promise((resolve) => {
      const unregister = releases[pending.length]!;
      pending.push(() => resolve({ unregister }));
    }));
    const first = start();
    first.unmount();
    const view = start();

    await act(async () => pending.forEach((resolve) => resolve()));
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).not.toHaveBeenCalled();
    act(() => {
      onAction.mock.calls[0]![0](tap());
      onAction.mock.calls[1]![0](tap());
    });
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });
});

describe('saying which session wants the reader', () => {
  it('says the session and what happened', async () => {
    const view = start();
    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());

    view.rerender({ wanted: [wants('a', 'blocked')] });

    await waitFor(() =>
      expect(sendNotification).toHaveBeenCalledWith({ title: 'Biomes', body: 'Waiting for an answer', extra: { sessionId: 'a' } }),
    );
  });

  it('tells a finish apart from a failure', async () => {
    const view = start();
    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());

    view.rerender({ wanted: [wants('a', 'finished'), wants('b', 'failed', 'Desktop')] });

    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
    expect(sendNotification.mock.calls.map(([options]) => options)).toEqual([
      { title: 'Biomes', body: 'Finished, and the reply is waiting', extra: { sessionId: 'a' } },
      { title: 'Desktop', body: 'Ended in an error', extra: { sessionId: 'b' } },
    ]);
  });

  it('names a session that was never titled', async () => {
    const view = start();
    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());

    view.rerender({ wanted: [wants('a', 'blocked', null)] });

    await waitFor(() => expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Untitled session' })));
  });

  /**
   * The list is a standing account of what is owed, not a stream of events, so it arrives
   * again on every render that touches it.
   */
  it('says it once, however often it is told', async () => {
    const view = start();
    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());

    view.rerender({ wanted: [wants('a', 'blocked')] });
    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));

    view.rerender({ wanted: [wants('a', 'blocked')] });
    view.rerender({ wanted: [wants('a', 'blocked')] });

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('says it again when the same session wants something new', async () => {
    const view = start();
    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());

    view.rerender({ wanted: [wants('a', 'blocked')] });
    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));

    view.rerender({ wanted: [wants('a', 'finished')] });

    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
  });

  /** Answered and asked again is a new thing to say, which is why the record is not cumulative. */
  it('says it again when a session is wanted, answered, and wanted once more', async () => {
    const view = start();
    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());

    view.rerender({ wanted: [wants('a', 'blocked')] });
    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    view.rerender({ wanted: [] });
    view.rerender({ wanted: [wants('a', 'blocked')] });

    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
  });

  /**
   * Opening the app to a session that was already blocked is not news. Announcing what was
   * merely found on arrival would mean a handful of notifications every launch.
   */
  it('says nothing about what was already owed when it started', async () => {
    renderHook(() => useNotify([wants('a', 'blocked'), wants('b', 'failed')], opened));

    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('asks for permission when it has not been given', async () => {
    isPermissionGranted.mockResolvedValue(false);
    start();

    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
  });

  /**
   * Permission is asked for asynchronously, and sessions do not wait for the answer. Writing
   * down what was owed before anything may be said about it would mark it as told and then
   * never tell it, which is the one failure here nobody would ever notice.
   */
  it('still says what arrived while permission was being asked for', async () => {
    let settle = (_granted: boolean) => {};
    isPermissionGranted.mockReturnValue(new Promise<boolean>((resolve) => (settle = resolve)));

    const view = start();
    view.rerender({ wanted: [wants('a', 'blocked')] });
    expect(sendNotification).not.toHaveBeenCalled();

    settle(true);

    await waitFor(() =>
      expect(sendNotification).toHaveBeenCalledWith({ title: 'Biomes', body: 'Waiting for an answer', extra: { sessionId: 'a' } }),
    );
  });

  it('does not ask again when permission is already given', async () => {
    start();

    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('says nothing at all when the reader refused', async () => {
    isPermissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue('denied');
    const view = start();
    await waitFor(() => expect(requestPermission).toHaveBeenCalled());

    view.rerender({ wanted: [wants('a', 'blocked')] });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('swallows a failure rather than surfacing it', async () => {
    sendNotification.mockImplementation(() => {
      throw new Error('no notifications here');
    });
    const view = start();
    await waitFor(() => expect(isPermissionGranted).toHaveBeenCalled());

    expect(() => view.rerender({ wanted: [wants('a', 'blocked')] })).not.toThrow();
  });
});
