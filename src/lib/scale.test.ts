// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { BASE_PX, LARGEST, SCALE_KEY, SMALLEST, STEP, applyScale, clampScale, readScale } from './scale';
import { resetStores, save } from './store';

beforeEach(() => {
  localStorage.clear();
  resetStores();
});

describe('keeping a scale usable', () => {
  it('leaves an ordinary one alone', () => {
    expect(clampScale(1.25)).toBe(1.25);
  });

  it('will not go below what can be read', () => {
    expect(clampScale(0.1)).toBe(SMALLEST);
  });

  it('will not go above what still fits on screen', () => {
    expect(clampScale(99)).toBe(LARGEST);
  });

  /** Steps are eighths, and floats do not add up to eighths without help. */
  it('rounds off what repeated steps accumulate', () => {
    expect(clampScale(1 + STEP + STEP + STEP)).toBe(1.375);
  });

  it('falls back to the app own size for a number that is not one', () => {
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe('remembering it', () => {
  it('starts at the app own size when nothing was chosen', () => {
    expect(readScale()).toBe(1);
  });

  it('reads back what was stored', () => {
    save('settings', SCALE_KEY, '1.25');

    expect(readScale()).toBe(1.25);
  });

  // Anything could be in there, including something another version of the app wrote.
  it('ignores a stored value that is not a number', () => {
    save('settings', SCALE_KEY, 'enormous');

    expect(readScale()).toBe(1);
  });

  it('brings a stored value that is out of range back in', () => {
    save('settings', SCALE_KEY, '40');

    expect(readScale()).toBe(LARGEST);
  });
});

describe('putting it into effect', () => {
  /** Every size in the app is a ratio of this one, so nothing else has to be told. */
  it('sets the base the whole scale is derived from', () => {
    const root = document.createElement('div');

    applyScale(1.5, root);

    expect(root.style.getPropertyValue('--font-base')).toBe(`${BASE_PX * 1.5}px`);
  });
});
