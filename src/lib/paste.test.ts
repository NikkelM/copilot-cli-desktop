// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_PASTE_BYTES } from '../../shared/protocol';
import { stashFiles } from './paste';
import { stashPaste } from './sidecar';

vi.mock('./sidecar', () => ({ stashPaste: vi.fn() }));

const stash = vi.mocked(stashPaste);

/** A file of a given size without allocating it as a string. */
function sized(name: string, bytes: number): File {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

beforeEach(() => {
  stash.mockReset();
  stash.mockImplementation(({ name }) => Promise.resolve(`C:\\state\\desktop-pastes\\${name}`));
});

describe('attaching pasted files', () => {
  it('sends the bytes and attaches the path that comes back', async () => {
    const { attached, tooLarge } = await stashFiles('s1', [new File(['pixels'], 'image.png')]);

    expect(stash).toHaveBeenCalledWith({
      sessionId: 's1',
      name: 'image.png',
      data: Buffer.from('pixels').toString('base64'),
    });
    expect(attached).toEqual([
      { type: 'file', path: 'C:\\state\\desktop-pastes\\image.png', displayName: 'image.png' },
    ]);
    expect(tooLarge).toEqual([]);
  });

  it('names the attachment after the file that was written, not the one that was pasted', async () => {
    // Two screenshots are both called image.png, so the second is written under another name.
    stash.mockResolvedValue('C:\\state\\desktop-pastes\\image-2.png');

    const { attached } = await stashFiles('s1', [new File(['x'], 'image.png')]);

    expect(attached[0]?.displayName).toBe('image-2.png');
  });

  it('takes several files in one paste', async () => {
    const { attached } = await stashFiles('s1', [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);

    expect(attached.map((file) => file.displayName)).toEqual(['a.txt', 'b.txt']);
  });

  it('reports a file past the limit without reading it', async () => {
    const { attached, tooLarge } = await stashFiles('s1', [sized('huge.bin', MAX_PASTE_BYTES + 1)]);

    expect(tooLarge).toEqual(['huge.bin']);
    expect(attached).toEqual([]);
    expect(stash).not.toHaveBeenCalled();
  });

  it('still attaches the rest when one file is too large', async () => {
    const { attached, tooLarge } = await stashFiles('s1', [
      sized('huge.bin', MAX_PASTE_BYTES + 1),
      new File(['ok'], 'small.png'),
    ]);

    expect(tooLarge).toEqual(['huge.bin']);
    expect(attached.map((file) => file.displayName)).toEqual(['small.png']);
  });

  it('names an unnamed file rather than sending an empty one', async () => {
    await stashFiles('s1', [new File(['x'], '')]);

    expect(stash).toHaveBeenCalledWith(expect.objectContaining({ name: 'paste' }));
  });
});
