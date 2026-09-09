import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { MAX_PASTE_BYTES, type StashParams } from '../../shared/protocol.js';
import { sessionStateDir } from './paths.js';

/**
 * Where pasted bytes land.
 *
 * A message can only carry a path, and clipboard content has none: a screenshot exists
 * nowhere until something writes it. Under the session's own state directory rather than a
 * temp folder, so what a session was sent stays beside the rest of its record, and so
 * deleting the session takes its pastes with it.
 */
export function pasteDir(sessionId: string): string {
  return join(sessionStateDir(sessionId), 'desktop-pastes');
}

/** How long a paste is kept. Long enough to look back at, short enough not to accumulate. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Write a pasted file and return the path to attach.
 *
 * Names are kept readable rather than made unique with a timestamp, because the agent is
 * shown this path: a second screenshot becomes `image-2.png`, which is what a person
 * saving two files would have done.
 */
export function stashPaste({ sessionId, name, data }: StashParams, now = Date.now()): string {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength > MAX_PASTE_BYTES) {
    throw new Error(`Too large to paste (${Math.round(bytes.byteLength / 1024 / 1024)}MB). Attach it instead.`);
  }

  const dir = pasteDir(sessionId);
  mkdirSync(dir, { recursive: true });
  prune(dir, now);

  const path = join(dir, free(dir, safeName(name)));
  writeFileSync(path, bytes);
  return path;
}

/**
 * A bare, harmless filename.
 *
 * The name comes from the clipboard, so it is the one part of this that a page or another
 * application chose. Reduced to a basename with only ordinary characters, so it cannot
 * climb out of the directory or name a device.
 */
function safeName(name: string): string {
  const bare = basename(name.split(/[\\/]/).join('/'))
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);

  return bare || 'paste';
}

/** The given name, or the first `-2`, `-3` variant of it that is not taken. */
function free(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/** Drop pastes older than a week, so the directory does not grow for the life of a session. */
function prune(dir: string, now: number): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    try {
      if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
    } catch {
      // A file that vanished between listing and reading needs no cleaning up.
    }
  }
}
