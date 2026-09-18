// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MULTIPLE,
  NARROWEST,
  WIDEST,
  WIDTH_KEY,
  applyHidden,
  applyWidth,
  clampWidth,
  readHidden,
  readWidth,
} from './sidebarWidth';

const store = (value: string | null) => ({ getItem: () => value });

describe('clampWidth', () => {
  it('keeps a width that is already usable', () => {
    expect(clampWidth(20)).toBe(20);
  });

  it('will not let the sidebar be dragged to nothing', () => {
    expect(clampWidth(0)).toBe(NARROWEST);
    expect(clampWidth(-40)).toBe(NARROWEST);
  });

  it('will not let it take the window', () => {
    expect(clampWidth(500)).toBe(WIDEST);
  });

  it('rounds off the noise a drag accumulates', () => {
    expect(clampWidth(18.750000001)).toBe(18.75);
    expect(clampWidth(20.123456)).toBe(20.12);
  });

  it('falls back to the default for a number that is not one', () => {
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_MULTIPLE);
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MULTIPLE);
  });
});

describe('readWidth', () => {
  it('says nothing was chosen when nothing was', () => {
    // Distinct from the default: never having chosen follows the default if it ever moves.
    expect(readWidth(store(null))).toBeNull();
  });

  it('reads a width that was', () => {
    expect(readWidth(store('22.5'))).toBe(22.5);
  });

  it('brings a stored width that is out of range back inside it', () => {
    expect(readWidth(store('900'))).toBe(WIDEST);
  });

  it('ignores a stored value that is not a number', () => {
    expect(readWidth(store('wide'))).toBeNull();
  });
});

describe('applyWidth', () => {
  it('writes the column as a multiple of the text size, not as pixels', () => {
    // Pixels would mean a width chosen at one scale becomes a different amount of sidebar
    // at another, which is the whole reason the multiple is what gets stored.
    const root = document.createElement('div');

    applyWidth(24, root);

    expect(root.style.getPropertyValue('--sidebar-column')).toBe('calc(var(--font-base) * 24)');
  });

  it('hands the column back to the stylesheet when nothing is chosen', () => {
    const root = document.createElement('div');
    applyWidth(24, root);

    applyWidth(null, root);

    expect(root.style.getPropertyValue('--sidebar-column')).toBe('');
  });
});

describe('what the sidebar width is stored under', () => {
  it('sits beside the app other choices', () => {
    expect(WIDTH_KEY).toBe('copilot-desktop.sidebarWidth');
  });
});

describe('whether the sidebar is hidden', () => {
  it('is shown when nothing says otherwise', () => {
    expect(readHidden(store(null))).toBe(false);
  });

  it('is hidden when that is what was stored', () => {
    expect(readHidden(store('true'))).toBe(true);
  });

  it('is shown for anything it does not recognise', () => {
    // A sidebar that is hidden by a value nobody wrote is the harder state to get out of.
    expect(readHidden(store('yes'))).toBe(false);
    expect(readHidden(store(''))).toBe(false);
  });

  it('marks the document rather than setting a width of zero', () => {
    // The two differ to everything else: a hidden sidebar should not be reachable by Tab.
    const root = document.createElement('div');

    applyHidden(true, root);
    expect(root.classList.contains('sidebar-hidden')).toBe(true);

    applyHidden(false, root);
    expect(root.classList.contains('sidebar-hidden')).toBe(false);
  });

  it('leaves a chosen width alone, so showing it again brings that one back', () => {
    const root = document.createElement('div');
    applyWidth(24, root);

    applyHidden(true, root);

    expect(root.style.getPropertyValue('--sidebar-column')).toBe('calc(var(--font-base) * 24)');
  });
});