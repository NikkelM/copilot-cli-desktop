// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyText } from './clipboard';

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset();
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('putting text on the clipboard', () => {
  it('writes what it was given', async () => {
    writeText.mockResolvedValue(undefined);
    await copyText('session-abc');

    expect(writeText).toHaveBeenCalledWith('session-abc');
  });

  it('says it worked', async () => {
    writeText.mockResolvedValue(undefined);

    await expect(copyText('ok')).resolves.toBe(true);
  });

  // Saying nothing on failure would look exactly like succeeding, which is the one
  // outcome worse than failing.
  it('says it failed rather than throwing', async () => {
    writeText.mockRejectedValue(new Error('denied'));

    await expect(copyText('nope')).resolves.toBe(false);
  });

  it('copies an empty string rather than treating it as nothing to do', async () => {
    writeText.mockResolvedValue(undefined);
    await copyText('');

    expect(writeText).toHaveBeenCalledWith('');
  });
});
