import { describe, expect, it } from 'vitest';

import { agentChanges } from './agentChanges';
import type { TranscriptEvent } from '../../shared/protocol';

/** A write starting, which is the only event that says which tool a completion belongs to. */
const starts = (call: string, toolName: string): TranscriptEvent =>
  ({ type: 'tool.execution_start', data: { toolCallId: call, toolName } }) as TranscriptEvent;

const ends = (call: string, patch: string | null, at = '2026-10-01T10:00:00.000Z', success = true): TranscriptEvent =>
  ({
    type: 'tool.execution_complete',
    timestamp: at,
    data: { toolCallId: call, success, result: patch === null ? {} : { detailedContent: patch } },
  }) as TranscriptEvent;

const created = (path: string, lines = 2) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => `+line ${index}`),
  ].join('\n');

const edited = (path: string, added = 1, removed = 1) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ' context',
    ...Array.from({ length: removed }, (_, index) => `-was ${index}`),
    ...Array.from({ length: added }, (_, index) => `+now ${index}`),
  ].join('\n');

const wrote = (call: string, tool: string, patch: string | null, at?: string, success?: boolean) => [
  starts(call, tool),
  ends(call, patch, at, success),
];

describe('agentChanges', () => {
  it('says nothing about a run that wrote nothing', () => {
    expect(agentChanges([])).toEqual({ changes: [], diffs: {} });
  });

  it('reports a file the run created, with the counts the patch carries', () => {
    const { changes } = agentChanges(wrote('c1', 'create', created('a.ts', 3)));

    expect(changes).toEqual([
      {
        path: 'a.ts',
        status: 'created',
        linesAdded: 3,
        linesRemoved: 0,
        turns: 1,
        changedAt: '2026-10-01T10:00:00.000Z',
        diffable: true,
      },
    ]);
  });

  /** The row is drawn from a diff the run reported, so there is no version to go and find. */
  it('offers the diff with the list rather than on request', () => {
    const { diffs } = agentChanges(wrote('c1', 'create', created('a.ts')));

    expect(diffs['a.ts']).toEqual({ patch: null, patches: [expect.stringContaining('+++ b/a.ts')], stale: false });
  });

  it('adds up several writes to one file, keeping each one apart', () => {
    const { changes, diffs } = agentChanges([
      ...wrote('c1', 'create', created('a.ts', 2), '2026-10-01T10:00:00.000Z'),
      ...wrote('c2', 'edit', edited('a.ts', 3, 1), '2026-10-01T11:00:00.000Z'),
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ linesAdded: 5, linesRemoved: 1, turns: 2 });
    // Newest last, because each write's line numbers count what the one before it left.
    expect(diffs['a.ts']?.patches).toHaveLength(2);
    expect(diffs['a.ts']?.patches?.[1]).toContain('+now 0');
    expect(changes[0]?.changedAt, 'the row dates from the last write').toBe('2026-10-01T11:00:00.000Z');
  });

  /** A file it made is one it made, however many times it rewrote it afterwards. */
  it('keeps a created file created when the run edits it again', () => {
    const { changes } = agentChanges([
      ...wrote('c1', 'create', created('a.ts')),
      ...wrote('c2', 'edit', edited('a.ts')),
    ]);

    expect(changes[0]?.status).toBe('created');
  });

  it('leaves out a write that failed', () => {
    expect(agentChanges(wrote('c1', 'edit', edited('a.ts'), undefined, false)).changes).toEqual([]);
  });

  it('leaves out a write that reported no diff', () => {
    expect(agentChanges(wrote('c1', 'edit', null)).changes).toEqual([]);
  });

  /** Writing a file without changing it reports a patch of nothing but context. */
  it('leaves out a write that moved nothing', () => {
    const unchanged = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', ' context'].join(
      '\n',
    );

    expect(agentChanges(wrote('c1', 'edit', unchanged)).changes).toEqual([]);
  });

  /**
   * A completion does not say which tool it belongs to, so the start is what decides. Without
   * that pairing anything reporting something diff-shaped would be counted as a write.
   */
  it.each(['view', 'powershell', 'bash', 'git_diff'])('leaves %s inspection output out of the run changes', (toolName) => {
    expect(agentChanges(wrote('c1', toolName, edited('a.ts'))).changes).toEqual([]);
  });

  it('leaves out a completion with no start behind it', () => {
    expect(agentChanges([ends('c1', edited('a.ts'))]).changes).toEqual([]);
  });

  /** `apply_patch` is handed one envelope and names its files inside it. */
  it('splits an envelope that names several files', () => {
    const both = `${edited('a.ts')}\n${created('b.ts')}`;

    expect(agentChanges(wrote('c1', 'apply_patch', both)).changes.map((c) => c.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('puts the most recently touched first', () => {
    const { changes } = agentChanges([
      ...wrote('c1', 'create', created('old.ts'), '2026-10-01T09:00:00.000Z'),
      ...wrote('c2', 'create', created('new.ts'), '2026-10-01T12:00:00.000Z'),
    ]);

    expect(changes.map((c) => c.path)).toEqual(['new.ts', 'old.ts']);
  });
});
