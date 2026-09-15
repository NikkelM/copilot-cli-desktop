import { describe, expect, it } from 'vitest';

import type { SessionUsage } from '../../shared/protocol';
import { usageReport } from './usageReport';

const cold = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  premiumRequests: 390,
  aiu: 1057.76875,
  loaded: false,
  ...over,
});

const loaded = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  ...cold(),
  loaded: true,
  tokens: { input: 4242694, output: 21306, cacheRead: 3657572, cacheWrite: 585020, reasoning: 0 },
  requests: 51,
  apiDurationMs: 331549,
  startedAt: '2026-09-13T22:54:00.166Z',
  codeChanges: { linesAdded: 136, linesRemoved: 8, filesModified: 5 },
  models: [{ model: 'claude-opus-5', requests: 51, cost: 300 }],
  ...over,
});

describe('reporting what a session cost', () => {
  it('leads with the two figures every session can answer', () => {
    const report = usageReport(cold());

    expect(report).toContain('| Premium requests | 390 |');
    expect(report).toContain('| AI units | 1,058 |');
  });

  /**
   * A session that has never finished a turn has no checkpoint, and zeroes would claim it
   * cost nothing rather than that nothing is recorded.
   */
  it('says nothing is recorded rather than reporting zero', () => {
    expect(usageReport(null)).toContain('Nothing recorded yet');
    expect(usageReport(null)).not.toContain('|');
  });

  it('accounts for tokens when a loaded session answered', () => {
    const report = usageReport(loaded());

    expect(report).toContain('| Tokens in | 4,242,694 |');
    expect(report).toContain('| Tokens out | 21,306 |');
    expect(report).toContain('| Model calls | 51 |');
  });

  // Cached tokens are most of a long session's input and are charged differently, so
  // folding them into one figure reads as far more expensive than it was.
  it('separates cached tokens from fresh ones', () => {
    expect(usageReport(loaded())).toContain('| Cache read / written | 3,657,572 / 585,020 |');
  });

  it('leaves out a cache row for a session that never used one', () => {
    const report = usageReport(loaded({ tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }));

    expect(report).not.toContain('Cache');
  });

  it('reports thinking only when the model did some', () => {
    expect(usageReport(loaded())).not.toContain('Thinking');
    expect(
      usageReport(loaded({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 900 } })),
    ).toContain('| Thinking | 900 |');
  });

  it('says what the agent changed', () => {
    expect(usageReport(loaded())).toContain('| Code changed | +136 -8 in 5 files |');
  });

  it('counts a single file as one', () => {
    const report = usageReport(loaded({ codeChanges: { linesAdded: 3, linesRemoved: 0, filesModified: 1 } }));

    expect(report).toContain('in 1 file |');
  });

  it('leaves out code changes when the agent changed nothing', () => {
    const report = usageReport(loaded({ codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: 0 } }));

    expect(report).not.toContain('Code changed');
  });

  /** One model is already the answer; the breakdown only earns its space when there is a split. */
  it('breaks down by model only when more than one was used', () => {
    expect(usageReport(loaded())).not.toContain('By model');

    const shared = usageReport(
      loaded({
        models: [
          { model: 'claude-opus-5', requests: 40, cost: 300 },
          { model: 'gpt-5.4', requests: 11, cost: 90 },
        ],
      }),
    );
    expect(shared).toContain('By model:');
    expect(shared).toContain('- claude-opus-5: 40 calls, 300 premium');
    expect(shared).toContain('- gpt-5.4: 11 calls, 90 premium');
  });

  it('leaves out a model that was never called', () => {
    const report = usageReport(
      loaded({
        models: [
          { model: 'claude-opus-5', requests: 40, cost: 300 },
          { model: 'gpt-5.4', requests: 11, cost: 90 },
          { model: 'never-used', requests: 0, cost: 0 },
        ],
      }),
    );

    expect(report).not.toContain('never-used');
  });

  /**
   * The difference is worth stating rather than showing as absent rows: a reader who wants
   * the detail should know that getting it means loading the session.
   */
  it('says why a cold session has less to report', () => {
    expect(usageReport(cold())).toContain('only known while the session is loaded');
    expect(usageReport(loaded())).not.toContain('only known while the session is loaded');
  });

  describe('the figures themselves', () => {
    it('does not imply a precision a whole number of requests does not have', () => {
      expect(usageReport(cold({ premiumRequests: 45 }))).toContain('| Premium requests | 45 |');
    });

    it('keeps the fraction when a multiplier produced one', () => {
      expect(usageReport(cold({ premiumRequests: 45.5 }))).toContain('| Premium requests | 45.5 |');
    });

    it('shows a small number of AI units with the decimals that carry its meaning', () => {
      expect(usageReport(cold({ aiu: 2.048 }))).toContain('| AI units | 2.05 |');
    });

    it('reports no spend as nothing rather than as a rounded fraction', () => {
      expect(usageReport(cold({ aiu: 0 }))).toContain('| AI units | 0 |');
    });

    it.each([
      [500, '500ms'],
      [4200, '4s'],
      [331549, '5m 32s'],
      [7_500_000, '2h 5m'],
    ])('reads %i ms as %s', (ms, shown) => {
      expect(usageReport(loaded({ apiDurationMs: ms }))).toContain(`| Time in the model | ${shown} |`);
    });

    // Every resumed session measured reported zero here, and a row saying so reads as a
    // session that waited on nothing rather than one that was not asked.
    it('leaves out the time row when the runtime reported none', () => {
      expect(usageReport(loaded({ apiDurationMs: 0 }))).not.toContain('Time in the model');
    });
  });
});
