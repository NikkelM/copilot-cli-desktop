import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_PREVIEW_BYTES } from '../../shared/protocol.js';
import { previewImage } from './images.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccd-images-'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, bytes: Buffer | string): string => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

describe('previewing an image', () => {
  it('hands back the bytes as a data URL', () => {
    const path = write('shot.png', Buffer.from([1, 2, 3]));

    expect(previewImage(path)).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  });

  it('names the type from the extension', () => {
    expect(previewImage(write('photo.JPG', 'x'))?.startsWith('data:image/jpeg;')).toBe(true);
  });

  // An attachment is whatever the reader picked, and only bitmaps are wanted here.
  it('refuses a file that is not an image', () => {
    expect(previewImage(write('notes.log', 'hello'))).toBeNull();
  });

  /** SVG is a document rather than a bitmap, so it is not handed to the webview. */
  it('refuses an SVG', () => {
    expect(previewImage(write('logo.svg', '<svg />'))).toBeNull();
  });

  it('refuses a file with no extension at all', () => {
    expect(previewImage(write('README', 'hello'))).toBeNull();
  });

  // A hover is not the way to look at a scan, and the bytes cross the pipe as base64.
  it('refuses one past the size limit', () => {
    expect(previewImage(write('huge.png', Buffer.alloc(MAX_PREVIEW_BYTES + 1)))).toBeNull();
  });

  it('takes one right at the limit', () => {
    expect(previewImage(write('big.png', Buffer.alloc(MAX_PREVIEW_BYTES)))).not.toBeNull();
  });

  // A tool call can name a file that has since been deleted, or never existed.
  it('says nothing about a file that is not there', () => {
    expect(previewImage(join(dir, 'gone.png'))).toBeNull();
  });
});
