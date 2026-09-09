/// <reference types="node" />
// The frontend tsconfig deliberately has no node globals, and this one file reads the
// repository off disk. Asked for by name here rather than opened up for everything in it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as protocol from './protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rust = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const listeners = readFileSync(join(root, 'src', 'lib', 'sidecar.ts'), 'utf8');

/** Every notification the sidecar can send, by the name it sends it under. */
const notifications = Object.entries(protocol)
  .filter(([name]) => name.startsWith('NOTIFY_'))
  .map(([name, method]) => [name, method as string] as const);

/**
 * A notification crosses three vocabularies with nothing linking them.
 *
 * The sidecar sends the name in `protocol.ts`, the Rust reader matches that name as a
 * literal and re-emits a hyphenated one, and the frontend listens for the hyphenated
 * literal. No type spans the boundary, and an unrecognised method is dropped without a
 * word, so renaming one end stops live events with no compiler error and nothing failing
 * anywhere. These tests are that missing link.
 */
describe('notifications across the sidecar, shell and frontend', () => {
  it('has notifications to check', () => {
    expect(notifications.length).toBeGreaterThan(0);
  });

  it.each(notifications)('%s is forwarded by the Rust reader', (_name, method) => {
    expect(rust).toContain(`"${method}" =>`);
  });

  it.each(notifications)('%s is listened for by the frontend', (_name, method) => {
    // The shell's own convention: dots become hyphens, and nothing else changes.
    expect(listeners).toContain(`'${method.replace(/\./g, '-')}'`);
  });

  /**
   * The other direction: an arm nobody sends is either a rename half-applied or a
   * notification that was removed from the sidecar and left forwarded here.
   */
  it('forwards nothing the sidecar does not send', () => {
    const arms = [...rust.matchAll(/"([a-z]+\.[a-z_]+)" => "([a-z-]+)"/g)].map((match) => match[1]);
    const sent = new Set(notifications.map(([, method]) => method));

    expect(arms.filter((method) => !sent.has(method!))).toEqual([]);
  });
});
