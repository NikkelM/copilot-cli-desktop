import { describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../../shared/protocol';
import { bulkActions, type BulkActionDeps } from './bulkActions';

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    sessionId: id,
    title: `Session ${id}`,
    cwd: null,
    repository: null,
    branch: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    loaded: false,
    ...over,
  }) as SessionSummary;

const deps = (over: Partial<BulkActionDeps> = {}): BulkActionDeps => ({
  archived: [],
  toggleArchived: vi.fn(),
  favourites: [],
  toggleFavourite: vi.fn(),
  unload: vi.fn(),
  remove: vi.fn(),
  exportAll: vi.fn(),
  ...over,
});

const byId = (sessions: SessionSummary[], d: BulkActionDeps) =>
  Object.fromEntries(bulkActions(sessions, d).map((a) => [a.id, a]));

const three = [session('a'), session('b'), session('c')];

/**
 * What a marked set of sessions offers (#63).
 *
 * One decision per action rather than one per session: being asked four times about four
 * marked sessions is not bulk anything.
 */
describe('acting on several sessions', () => {
  it('offers only what makes sense for a set', () => {
    expect(bulkActions(three, deps()).map((a) => a.id)).toEqual([
      'bulk-favourite',
      'bulk-archive',
      'bulk-unload',
      'bulk-export',
      'bulk-delete',
    ]);
  });

  it('says how many it is about', () => {
    expect(byId(three, deps())['bulk-delete']?.label).toBe('Delete 3 sessions');
  });

  it('counts one session as one', () => {
    expect(byId([session('a')], deps())['bulk-delete']?.label).toBe('Delete 1 session');
  });

  describe('favouriting', () => {
    it('makes them all favourites when none is', () => {
      const d = deps();

      byId(three, d)['bulk-favourite']?.run();

      expect(d.toggleFavourite).toHaveBeenCalledTimes(3);
    });

    /** A mixed set moves the way that leaves it in one state, which is all favourites. */
    it('only moves the ones that are not already', () => {
      const d = deps({ favourites: ['a'] });

      byId(three, d)['bulk-favourite']?.run();

      expect(d.toggleFavourite).toHaveBeenCalledTimes(2);
      expect(d.toggleFavourite).not.toHaveBeenCalledWith('a');
    });

    it('offers to undo it once they all are', () => {
      const d = deps({ favourites: ['a', 'b', 'c'] });

      expect(byId(three, d)['bulk-favourite']?.label).toBe('Unfavourite 3 sessions');
    });

    it('takes them all back off when they all are', () => {
      const d = deps({ favourites: ['a', 'b', 'c'] });

      byId(three, d)['bulk-favourite']?.run();

      expect(d.toggleFavourite).toHaveBeenCalledTimes(3);
    });
  });

  describe('archiving', () => {
    it('puts them all away when none is', () => {
      const d = deps();

      byId(three, d)['bulk-archive']?.run();

      expect(d.toggleArchived).toHaveBeenCalledTimes(3);
    });

    it('offers to bring them back once they are all away', () => {
      const d = deps({ archived: ['a', 'b', 'c'] });

      expect(byId(three, d)['bulk-archive']?.label).toBe('Bring back 3 sessions');
    });

    it('only moves the ones that are not already away', () => {
      const d = deps({ archived: ['b'] });

      byId(three, d)['bulk-archive']?.run();

      expect(d.toggleArchived).toHaveBeenCalledTimes(2);
      expect(d.toggleArchived).not.toHaveBeenCalledWith('b');
    });
  });

  describe('unloading', () => {
    it('counts only the ones that are in memory', () => {
      const d = deps();
      const mixed = [session('a', { loaded: true }), session('b'), session('c', { loaded: true })];

      expect(byId(mixed, d)['bulk-unload']?.label).toBe('Unload 2 sessions from memory');
    });

    it('releases only those', () => {
      const d = deps();
      const mixed = [session('a', { loaded: true }), session('b')];

      byId(mixed, d)['bulk-unload']?.run();

      expect(d.unload).toHaveBeenCalledOnce();
      expect(d.unload).toHaveBeenCalledWith('a');
    });

    it('is refused where none of them is in memory', () => {
      expect(byId(three, deps())['bulk-unload']?.refused).toBe('None of these are in memory.');
    });

    it('is offered where one of them is', () => {
      const mixed = [session('a', { loaded: true }), session('b')];

      expect(byId(mixed, deps())['bulk-unload']?.refused).toBeUndefined();
    });
  });

  it('hands the whole set over to be written out', () => {
    const d = deps();

    byId(three, d)['bulk-export']?.run();

    expect(d.exportAll).toHaveBeenCalledWith(three);
  });

  describe('deleting', () => {
    it('puts the whole set to the reader rather than removing it', () => {
      const d = deps();

      byId(three, d)['bulk-delete']?.run();

      expect(d.remove).toHaveBeenCalledWith(three);
    });

    /** It is the one that loses something, so it is drawn apart from the rest. */
    it('is marked as destructive', () => {
      expect(byId(three, deps())['bulk-delete']?.destructive).toBe(true);
    });

    it('is the only one that is', () => {
      expect(bulkActions(three, deps()).filter((a) => a.destructive).map((a) => a.id)).toEqual(['bulk-delete']);
    });
  });
});
