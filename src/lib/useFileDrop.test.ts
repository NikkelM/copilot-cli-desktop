// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { onDragDropEvent } = vi.hoisted(() => ({ onDragDropEvent: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: (h: (e: unknown) => void) => onDragDropEvent(h) }),
}));

import { useFileDrop } from './useFileDrop';

/** The handler the subscription was given, so a test can send what the runtime would. */
let drag: (event: { payload: Record<string, unknown> }) => void;
/** What the subscription handed back, to prove the listener is let go of. */
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  unlisten = vi.fn();
  onDragDropEvent.mockReset().mockImplementation((handler: typeof drag) => {
    drag = handler;
    return Promise.resolve(unlisten);
  });
});

const dropping = async (onDrop = vi.fn(), enabled = true) => {
  const view = renderHook(({ on, use }: { on: typeof onDrop; use: boolean }) => useFileDrop(on, use), {
    initialProps: { on: onDrop, use: enabled },
  });
  await waitFor(() => expect(onDragDropEvent).toHaveBeenCalled());
  return { ...view, onDrop };
};

const send = (payload: Record<string, unknown>) => act(() => drag({ payload }));

/**
 * Files dragged onto the window (#231).
 *
 * The runtime's own drag events rather than the webview's, because an attachment is a path
 * and HTML drag-and-drop hands over a `File` that has none.
 */
describe('a file dragged onto the window', () => {
  it('says nothing before anything is dragged', async () => {
    const { result } = await dropping();

    expect(result.current).toBe(false);
  });

  it('offers to take it as soon as it is over the window', async () => {
    const { result } = await dropping();

    send({ type: 'enter', paths: ['C:\\shots\\a.png'] });

    expect(result.current).toBe(true);
  });

  /** A drag that entered before the listener was up still reports itself as it moves. */
  it('offers to take one that is already moving over the window', async () => {
    const { result } = await dropping();

    send({ type: 'over' });

    expect(result.current).toBe(true);
  });

  it('takes back the offer when the drag leaves', async () => {
    const { result } = await dropping();
    send({ type: 'enter', paths: ['C:\\shots\\a.png'] });

    send({ type: 'leave' });

    expect(result.current).toBe(false);
  });

  it('hands over what was let go', async () => {
    const { onDrop } = await dropping();

    send({ type: 'drop', paths: ['C:\\shots\\a.png', 'C:\\shots\\b.png'] });

    expect(onDrop).toHaveBeenCalledWith(['C:\\shots\\a.png', 'C:\\shots\\b.png']);
  });

  /** The drag is over once it is let go, so an overlay left up would say it was not. */
  it('takes back the offer once the files are let go', async () => {
    const { result } = await dropping();
    send({ type: 'enter', paths: ['C:\\shots\\a.png'] });

    send({ type: 'drop', paths: ['C:\\shots\\a.png'] });

    expect(result.current).toBe(false);
  });

  it('says nothing about a drop that carried no paths', async () => {
    const { onDrop } = await dropping();

    send({ type: 'drop', paths: [] });

    expect(onDrop).not.toHaveBeenCalled();
  });

  /**
   * With nothing open there is nowhere for a drop to go, so the overlay would be promising
   * something the app would then have to refuse.
   */
  describe('with nowhere to put it', () => {
    it('offers nothing', async () => {
      const { result } = await dropping(vi.fn(), false);

      send({ type: 'enter', paths: ['C:\\shots\\a.png'] });

      expect(result.current).toBe(false);
    });

    it('takes nothing', async () => {
      const { onDrop } = await dropping(vi.fn(), false);

      send({ type: 'drop', paths: ['C:\\shots\\a.png'] });

      expect(onDrop).not.toHaveBeenCalled();
    });
  });

  /**
   * Re-subscribing mid-drag would tear the listener down between `enter` and `drop`, and a
   * `leave` arriving at a listener that is gone leaves the overlay up for ever. So the
   * current answer is read inside the handler rather than closed over.
   */
  it('keeps one listener while the session under it changes', async () => {
    const { rerender } = await dropping(vi.fn(), false);

    rerender({ on: vi.fn(), use: true });

    expect(onDragDropEvent).toHaveBeenCalledOnce();
  });

  it('takes a drop against the session open when it was let go', async () => {
    const { rerender } = await dropping(vi.fn(), false);
    const later = vi.fn();

    rerender({ on: later, use: true });
    send({ type: 'drop', paths: ['C:\\shots\\a.png'] });

    expect(later).toHaveBeenCalledWith(['C:\\shots\\a.png']);
  });

  it('lets the listener go with the window', async () => {
    const { unmount } = await dropping();

    unmount();

    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});
