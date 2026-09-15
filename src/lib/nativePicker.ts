import { cursorPosition, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';

/**
 * Wake a pointer Windows hid while the command was typed before a native dialog takes focus.
 *
 * Moving one physical pixel and immediately back makes Windows process real pointer movement
 * without leaving it somewhere the reader did not put it. A visibility call cannot do this:
 * Tauri suppresses it when its own cursor state already says visible.
 */
export async function revealPointerForPicker(userAgent = navigator.userAgent): Promise<void> {
  if (!userAgent.includes('Windows')) return;

  const current = getCurrentWindow();
  const [pointer, origin] = await Promise.all([cursorPosition(), current.innerPosition()]);
  const local = new PhysicalPosition(pointer.x - origin.x, pointer.y - origin.y);

  await current.setCursorPosition(new PhysicalPosition(local.x + 1, local.y));
  await current.setCursorPosition(local);
}
