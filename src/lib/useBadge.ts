import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Image } from '@tauri-apps/api/image';

/**
 * Which of the three a count is mostly about, since a number cannot say it (#267).
 *
 * The same vocabulary the sidebar marks use, so the colour on the icon and the colour on
 * the row are the same claim. Where several states are waiting at once the most urgent one
 * colours the badge, because that is the one deciding whether to come back.
 */
export type BadgeTone = 'blocked' | 'failed' | 'finished';

/**
 * How large the drawn icon is, in pixels.
 *
 * Windows wants 16x16 for an overlay at no scaling, and scales from there. Drawn at double
 * that and left to come down, which costs nothing and is the difference between a legible
 * digit and a smudge on a display running at 150%.
 */
const SIZE = 32;

/** Past this the number stops being readable at 16 pixels, so it stops being a number. */
const MOST = 9;

/**
 * The fallbacks matter: the window drawing this has a stylesheet, but anything reading a
 * custom property before one is applied gets an empty string, and an empty fill paints
 * nothing at all. These are the values in `App.css`.
 */
const COLOUR: Record<BadgeTone, { variable: string; fallback: string }> = {
  blocked: { variable: '--warning', fallback: '#d29922' },
  failed: { variable: '--danger', fallback: '#f85149' },
  finished: { variable: '--accent', fallback: '#2f81f7' },
};

/** What the badge says, which is a number until a number stops fitting. */
export function badgeLabel(count: number): string {
  return count > MOST ? `${MOST}+` : String(count);
}

/**
 * Draw the count, and hand back the pixels.
 *
 * Raw RGBA rather than a PNG, which is what keeps this cheap: Tauri's `JsImage` reaches the
 * decoders only for a path or for encoded bytes, both of which want the `image-png` or
 * `image-ico` cargo feature. The `Rgba` form wants neither, so there is nothing to encode
 * here and nothing to add to the build.
 *
 * Returns nothing where there is no canvas to draw on, which is every test environment:
 * jsdom implements no 2d context, and a missing badge is not worth failing a render over.
 */
function paint(count: number, tone: BadgeTone): Uint8Array | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const { variable, fallback } = COLOUR[tone];
  const themed = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();

  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
  ctx.fillStyle = themed || fallback;
  ctx.fill();

  const label = badgeLabel(count);
  // Narrower type for two characters, so "9+" sits inside the same circle one digit does.
  ctx.font = `bold ${label.length > 1 ? SIZE * 0.5 : SIZE * 0.68}px system-ui, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Half a pixel down: a baseline centred by metrics sits optically high, because digits
  // have no descender to balance the cap height.
  ctx.fillText(label, SIZE / 2, SIZE / 2 + SIZE * 0.04);

  // Copied out of the clamped array the canvas hands back, which is the one shape Tauri
  // does not take.
  return new Uint8Array(ctx.getImageData(0, 0, SIZE, SIZE).data);
}

/**
 * Count what wants the reader on the taskbar icon (#267).
 *
 * `setBadgeCount` is the obvious call and does nothing here: it is documented as
 * unsupported on Windows, pointing at `setOverlayIcon` instead. So the number is drawn and
 * handed over as pixels rather than said as a number.
 *
 * Only when the answer changes. Drawing is cheap but setting an overlay is a Win32 call
 * through two IPC hops, and renders happen constantly.
 */
export function useBadge(count: number, tone: BadgeTone | null): void {
  /**
   * The image currently on the icon, so it can be released.
   *
   * Every drawn badge becomes a resource on the Rust side that the frontend only holds a
   * handle to, and nothing releases it on its own before the app exits. Without this a
   * session that blocks and unblocks all afternoon leaves one behind every time.
   */
  const showing = useRef<Image | null>(null);

  useEffect(() => {
    const window = getCurrentWindow();
    const drawn = count > 0 && tone ? paint(count, tone) : null;

    // Failure here is cosmetic - a platform with no taskbar, or a window already gone - and
    // an error banner over it would be worse than the missing count.
    void (async () => {
      const next = drawn ? await Image.new(drawn, SIZE, SIZE) : null;
      await window.setOverlayIcon(next ?? undefined);

      // After the swap rather than before: releasing the image still on the icon is asking
      // the window manager to draw something that has been freed.
      await showing.current?.close();
      showing.current = next;
    })().catch(() => undefined);
  }, [count, tone]);
}
