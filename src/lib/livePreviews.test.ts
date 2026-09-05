import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../shared/protocol';
import { mergeLivePreviews } from './livePreviews';

const session = (id: string, updatedAt: string, preview: string | null): SessionSummary => ({
  sessionId: id,
  title: id,
  cwd: null,
  repository: null,
  branch: null,
  createdAt: updatedAt,
  updatedAt,
  preview,
  loaded: false,
});

describe('mergeLivePreviews', () => {
  // The refetch fires on every store change, so without the merge it immediately
  // overwrites what the app already saw happen.
  it('replaces the database preview with what was seen live', () => {
    const fetched = [session('a', '2026-09-05T15:00:00Z', 'stale reply')];
    expect(mergeLivePreviews(fetched, new Map([['a', 'live reply']]))[0]?.preview).toBe('live reply');
  });

  // updatedAt comes from the event log mtime and is already correct; the live value was
  // taken from a different clock, so letting it win here was an actual regression.
  it('leaves the timestamp alone', () => {
    const fetched = [session('a', '2026-09-05T15:00:00Z', 'stale reply')];
    expect(mergeLivePreviews(fetched, new Map([['a', 'live reply']]))[0]?.updatedAt).toBe(
      '2026-09-05T15:00:00Z',
    );
  });

  it('leaves sessions with no live preview untouched', () => {
    const fetched = [session('a', '2026-09-05T15:00:00Z', 'db reply')];
    expect(mergeLivePreviews(fetched, new Map([['other', 'x']]))).toEqual(fetched);
  });

  it('returns the same list when nothing is live', () => {
    const fetched = [session('a', '2026-09-05T15:00:00Z', 'db reply')];
    expect(mergeLivePreviews(fetched, new Map())).toBe(fetched);
  });

  it('can override with no preview at all', () => {
    const fetched = [session('a', '2026-09-05T15:00:00Z', 'db reply')];
    expect(mergeLivePreviews(fetched, new Map([['a', null]]))[0]?.preview).toBeNull();
  });
});
