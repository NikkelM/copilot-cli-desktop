import { describe, expect, it, vi } from 'vitest';

import { ORPHANED, RELOADABLE, adviceFor, windowOrphaned } from './staleWindow';

describe('whether a window has outlived the server that loaded it', () => {
  /** A packaged build serves its own files, so there is nothing it could be orphaned from. */
  it('says no for a build with no dev server behind it', async () => {
    const get = vi.fn();

    await expect(windowOrphaned(undefined, get as unknown as typeof fetch)).resolves.toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('says no while the server still answers', async () => {
    const get = vi.fn().mockResolvedValue(new Response(''));

    await expect(windowOrphaned({}, get as unknown as typeof fetch)).resolves.toBe(false);
  });

  it('says yes when it cannot be reached', async () => {
    const get = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(windowOrphaned({}, get as unknown as typeof fetch)).resolves.toBe(true);
  });

  // A stored copy would answer for a server that has gone, which is the thing being tested.
  it('will not let a cached answer stand in for the server', async () => {
    const get = vi.fn().mockResolvedValue(new Response(''));

    await windowOrphaned({}, get as unknown as typeof fetch);

    expect(get).toHaveBeenCalledWith('/@vite/client', { cache: 'no-store' });
  });
});

describe('what to tell the reader under a crash', () => {
  it('says to restart when reloading cannot reach anything', () => {
    expect(adviceFor(true)).toBe(ORPHANED);
    expect(adviceFor(true)).toMatch(/restart the app/i);
  });

  it('offers the reload when there is something to reload from', () => {
    expect(adviceFor(false)).toBe(RELOADABLE);
  });

  /**
   * The mistake this exists to prevent: a stack names whatever was being drawn, which is
   * where the reader goes, which is correct, which is where the time goes.
   */
  it('blames the build rather than whatever was on screen', () => {
    expect(ORPHANED).toMatch(/may be showing old code/i);
    expect(RELOADABLE).toMatch(/current code/i);
  });

  it('does not promise a reload will help when it will not', () => {
    expect(ORPHANED).toMatch(/Restart the app/i);
  });
});
