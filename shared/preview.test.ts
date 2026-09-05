import { describe, expect, it } from 'vitest';

import { toPreview, PREVIEW_LENGTH } from './preview.js';

describe('toPreview', () => {
  it('collapses whitespace so multi-line replies stay on one line', () => {
    expect(toPreview('one\n\n  two\tthree ')).toBe('one two three');
  });

  it('clips long text and marks the truncation', () => {
    const preview = toPreview('x'.repeat(500));
    expect(preview).toHaveLength(PREVIEW_LENGTH);
    expect(preview?.endsWith('…')).toBe(true);
  });

  it('treats empty and whitespace-only input as no preview', () => {
    expect(toPreview('')).toBeNull();
    expect(toPreview('   \n ')).toBeNull();
    expect(toPreview(null)).toBeNull();
    expect(toPreview(undefined)).toBeNull();
  });
});
