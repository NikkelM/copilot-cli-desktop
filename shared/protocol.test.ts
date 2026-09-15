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

/**
 * The version exists so that a frontend and a sidecar built from different method lists
 * refuse each other instead of failing later as a feature that looks broken (#169). What it
 * has to get right is narrow: change the contract and it changes, restate the same contract
 * and it does not.
 */
describe('the protocol version', () => {
  const { PROTOCOL_VERSION, SIDECAR_METHODS, protocolVersionOf } = protocol;

  it('describes the methods this build declares', () => {
    expect(protocolVersionOf(SIDECAR_METHODS)).toBe(PROTOCOL_VERSION);
  });

  // The list is written for reading, so its order is nobody's contract but its own.
  it('is unmoved by the order the methods are listed in', () => {
    expect(protocolVersionOf([...SIDECAR_METHODS].reverse())).toBe(PROTOCOL_VERSION);
  });

  it('changes when a method is added', () => {
    expect(protocolVersionOf([...SIDECAR_METHODS, 'sessions.somethingNew'])).not.toBe(PROTOCOL_VERSION);
  });

  it('changes when a method is taken away', () => {
    expect(protocolVersionOf(SIDECAR_METHODS.slice(1))).not.toBe(PROTOCOL_VERSION);
  });

  it('changes when a method is renamed', () => {
    const renamed = SIDECAR_METHODS.map((method) => (method === 'sessions.mode' ? 'sessions.getMode' : method));

    expect(protocolVersionOf(renamed)).not.toBe(PROTOCOL_VERSION);
  });

  /** Two names swapped is the same set, and the same set is the same contract. */
  it('is a fact about the set rather than about the text', () => {
    expect(protocolVersionOf(['a.one', 'b.two'])).toBe(protocolVersionOf(['b.two', 'a.one']));
    expect(protocolVersionOf(['a.one', 'b.two'])).not.toBe(protocolVersionOf(['a.one', 'b.three']));
  });

  it('is short enough to read out of a log', () => {
    expect(PROTOCOL_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });
});

/**
 * The transcript read sends only the events the transcript can draw, which is worth about
 * half of every page. Nothing links the list to the renderer that defines it except this:
 * one is a switch statement in the frontend, the other a list in a shared module, and a
 * case added to the first without a name added to the second would silently stop arriving.
 */
describe('the events the transcript is sent', () => {
  const entries = readFileSync(join(root, 'src', 'lib', 'transcriptEntries.ts'), 'utf8');

  /**
   * Only the cases inside `toEntries`. The file has other switches - the one naming why a
   * turn stopped, for instance - whose labels are not event types at all.
   */
  const rendered = (() => {
    const from = entries.indexOf('export function toEntries');
    const to = entries.indexOf('export function sameEntry');
    return [...entries.slice(from, to).matchAll(/case '([a-z_.]+)':/g)].map((match) => match[1]!);
  })();

  it('found the renderer to compare against', () => {
    expect(rendered.length).toBeGreaterThan(10);
  });

  it('carries exactly what the renderer draws', () => {
    expect([...protocol.TRANSCRIPT_EVENT_TYPES].sort()).toEqual([...rendered].sort());
  });

  it.each(['system.message', 'hook.start', 'hook.end', 'assistant.turn_start', 'assistant.turn_end'])(
    'does not carry %s, which draws nothing and is the bulk of a page',
    (type) => {
      expect(protocol.showsInTranscript(type)).toBe(false);
    },
  );

  it.each(['user.message', 'assistant.message', 'tool.execution_complete'])('carries %s', (type) => {
    expect(protocol.showsInTranscript(type)).toBe(true);
  });
});
