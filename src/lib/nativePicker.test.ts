// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { revealPointerForPicker } from './nativePicker';

const { cursorPosition, innerPosition, setCursorPosition } = vi.hoisted(() => ({
  cursorPosition: vi.fn(),
  innerPosition: vi.fn(),
  setCursorPosition: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  PhysicalPosition: class PhysicalPosition {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  cursorPosition,
  getCurrentWindow: () => ({ innerPosition, setCursorPosition }),
}));

beforeEach(() => {
  cursorPosition.mockReset().mockResolvedValue({ x: 480, y: 290 });
  innerPosition.mockReset().mockResolvedValue({ x: 100, y: 50 });
  setCursorPosition.mockReset().mockResolvedValue(undefined);
});

describe('revealing the pointer before a native picker', () => {
  it('nudges one physical pixel and puts the pointer back', async () => {
    await revealPointerForPicker('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(setCursorPosition).toHaveBeenNthCalledWith(1, { x: 381, y: 240 });
    expect(setCursorPosition).toHaveBeenNthCalledWith(2, { x: 380, y: 240 });
  });

  it('does nothing on platforms without the Windows mouse-vanish behavior', async () => {
    await revealPointerForPicker('Mozilla/5.0 (X11; Linux x86_64)');

    expect(cursorPosition).not.toHaveBeenCalled();
    expect(setCursorPosition).not.toHaveBeenCalled();
  });

  it('reports a failed nudge so the picker does not silently keep the broken behavior', async () => {
    setCursorPosition.mockRejectedValueOnce(new Error('not permitted'));

    await expect(revealPointerForPicker('Windows')).rejects.toThrow('not permitted');
  });
});
