// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { badgeLabel, useBadge, type BadgeTone } from './useBadge';

const setOverlayIcon = vi.fn(() => Promise.resolve());
const close = vi.fn(() => Promise.resolve());
const newImage = vi.fn(() => Promise.resolve({ close, rid: 1 }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setOverlayIcon }),
}));

vi.mock('@tauri-apps/api/image', () => ({
  Image: { new: (...args: unknown[]) => newImage(...(args as [])) },
}));

beforeEach(() => {
  setOverlayIcon.mockClear();
  close.mockClear();
  newImage.mockClear();
});

/**
 * Enough of a 2d context to draw into, since jsdom implements none.
 *
 * Without this the hook finds no canvas, draws nothing and sets no icon, so everything
 * downstream of the pixels - handing them over, and releasing the image they replaced -
 * goes untested.
 */
const withCanvas = () => {
  const ctx = {
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(32 * 32 * 4) })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  return ctx;
};

/**
 * What the badge says. Its own function because it is the only part of the drawing that is
 * a decision rather than a pixel, and the only part testable without a canvas.
 */
describe('what the badge says', () => {
  it('says the number while the number fits', () => {
    expect([1, 2, 5, 9].map(badgeLabel)).toEqual(['1', '2', '5', '9']);
  });

  /** Past nine a second digit stops being readable at sixteen pixels. */
  it('stops counting past nine', () => {
    expect(badgeLabel(10)).toBe('9+');
    expect(badgeLabel(250)).toBe('9+');
  });
});

/**
 * jsdom implements no 2d context, so nothing here can check the pixels. What it can check
 * is everything around them: when the icon is set, when it is taken away, and that the
 * image it replaced is released.
 */
describe('counting on the taskbar icon', () => {
  /** No canvas is every test environment, and a missing badge is not worth a failed render. */
  it('sets no icon at all where there is nothing to draw on', async () => {
    renderHook(() => useBadge(3, 'blocked'));

    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledWith(undefined));
    expect(newImage).not.toHaveBeenCalled();
  });

  /** Renders happen constantly, where setting an overlay is a Win32 call through two hops. */
  it('does not redraw while the answer is unchanged', async () => {
    const { rerender } = renderHook(({ count }) => useBadge(count, 'blocked'), {
      initialProps: { count: 2 },
    });
    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalled());
    setOverlayIcon.mockClear();

    rerender({ count: 2 });

    expect(setOverlayIcon).not.toHaveBeenCalled();
  });

  it('redraws when the count changes', async () => {
    const { rerender } = renderHook(({ count }) => useBadge(count, 'blocked'), {
      initialProps: { count: 1 },
    });
    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalled());
    setOverlayIcon.mockClear();

    rerender({ count: 2 });

    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledTimes(1));
  });

  it('redraws when only the state behind the count changes', async () => {
    const { rerender } = renderHook(({ tone }: { tone: BadgeTone }) => useBadge(1, tone), {
      initialProps: { tone: 'blocked' },
    });
    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalled());
    setOverlayIcon.mockClear();

    rerender({ tone: 'failed' });

    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledTimes(1));
  });

  it('swallows a failure rather than surfacing it', async () => {
    setOverlayIcon.mockRejectedValueOnce(new Error('no taskbar') as never);

    expect(() => renderHook(() => useBadge(0, null))).not.toThrow();
  });
});

/** With pixels to hand over, the rest of the path can be checked. */
describe('once there is a canvas to draw on', () => {
  it('takes the overlay away when nothing wants the reader', async () => {
    withCanvas();

    renderHook(() => useBadge(0, 'blocked'));

    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledWith(undefined));
    expect(newImage).not.toHaveBeenCalled();
  });

  /** A number with no state behind it cannot be coloured, so there is nothing honest to draw. */
  it('draws nothing for a count with no state to colour it', async () => {
    withCanvas();

    renderHook(() => useBadge(3, null));

    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledWith(undefined));
    expect(newImage).not.toHaveBeenCalled();
  });

  it('hands the drawn pixels over as the overlay', async () => {
    withCanvas();

    renderHook(() => useBadge(3, 'blocked'));

    await waitFor(() => expect(newImage).toHaveBeenCalledWith(expect.any(Uint8Array), 32, 32));
    expect(setOverlayIcon).toHaveBeenCalledWith(expect.objectContaining({ rid: 1 }));
  });

  it('draws the label the count asks for', async () => {
    const ctx = withCanvas();

    renderHook(() => useBadge(12, 'blocked'));

    await waitFor(() => expect(ctx.fillText).toHaveBeenCalled());
    expect(ctx.fillText.mock.calls[0]?.[0]).toBe('9+');
  });

  /**
   * Every drawn badge is a resource on the Rust side that nothing releases on its own
   * before the app exits, so a session blocking and unblocking all afternoon would leave
   * one behind each time.
   */
  it('releases the image it replaced', async () => {
    withCanvas();
    const { rerender } = renderHook(({ count }) => useBadge(count, 'blocked'), {
      initialProps: { count: 1 },
    });
    await waitFor(() => expect(newImage).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();

    rerender({ count: 2 });

    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  /** Releasing the one still on the icon would ask the window manager to draw a freed image. */
  it('releases it only after the new one is on the icon', async () => {
    withCanvas();
    const order: string[] = [];
    setOverlayIcon.mockImplementation(() => {
      order.push('set');
      return Promise.resolve();
    });
    close.mockImplementation(() => {
      order.push('close');
      return Promise.resolve();
    });

    const { rerender } = renderHook(({ count }) => useBadge(count, 'blocked'), {
      initialProps: { count: 1 },
    });
    await waitFor(() => expect(order).toContain('set'));
    rerender({ count: 2 });

    await waitFor(() => expect(order).toEqual(['set', 'set', 'close']));
  });
});
