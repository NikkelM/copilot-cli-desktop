// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MULTIPLE,
  HIDDEN_KEY,
  NARROWEST,
  WIDEST,
  WIDTH_KEY,
  applyHidden,
  applyWidth,
  clampWidth,
  readHidden,
  readWidth,
} from './sidebarWidth';
import { resetStores, save } from './store';

/** Put a value where the settings live, since that is where these read from now. */
function stored(key: string, value: string | null) {
  resetStores();
  if (value !== null) save('settings', key, value);
}

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
    expect((stored(WIDTH_KEY, null), readWidth())).toBeNull();
  });

  it('reads a width that was', () => {
    expect((stored(WIDTH_KEY, '22.5'), readWidth())).toBe(22.5);
  });

  it('brings a stored width that is out of range back inside it', () => {
    expect((stored(WIDTH_KEY, '900'), readWidth())).toBe(WIDEST);
  });

  it('ignores a stored value that is not a number', () => {
    expect((stored(WIDTH_KEY, 'wide'), readWidth())).toBeNull();
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
  it('is a decision someone made, so it lives with the settings', () => {
    expect(WIDTH_KEY).toBe('sidebarWidth');
  });
});

describe('whether the sidebar is hidden', () => {
  it('is shown when nothing says otherwise', () => {
    expect((stored(HIDDEN_KEY, null), readHidden())).toBe(false);
  });

  it('is hidden when that is what was stored', () => {
    expect((stored(HIDDEN_KEY, 'true'), readHidden())).toBe(true);
  });

  it('is shown for anything it does not recognise', () => {
    // A sidebar that is hidden by a value nobody wrote is the harder state to get out of.
    expect((stored(HIDDEN_KEY, 'yes'), readHidden())).toBe(false);
    expect((stored(HIDDEN_KEY, ''), readHidden())).toBe(false);
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