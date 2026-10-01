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
      'bulk-unload',
      'bulk-export',
      'bulk-archive',
      'bulk-delete',
    ]);
  });

  /**
   * A favourite is a session somebody reaches for, which is a judgement made one at a time.
   * A set of them made favourites together is a top of the list nobody chose.
   */
  it('leaves favouriting to one session at a time', () => {
    expect(bulkActions(three, deps()).map((a) => a.id)).not.toContain('bulk-favourite');
  });

  it('says how many it is about', () => {
    expect(byId(three, deps())['bulk-delete']?.label).toBe('Delete 3 sessions');
  });

  it('counts one session as one', () => {
    expect(byId([session('a')], deps())['bulk-delete']?.label).toBe('Delete 1 session');
  });

  /**
   * A short name for each, for somewhere the count is already on screen (#63).
   *
   * The bar above the list says how many are picked, and buttons repeating it fit nowhere
   * in a column the reader has dragged as narrow as they like.
   */
  describe('the short names', () => {
    it('gives every action one', () => {
      expect(bulkActions(three, deps()).every((action) => action.brief !== undefined)).toBe(true);
    });

    it('leaves the count out of them', () => {
      const brief = bulkActions(three, deps()).map((action) => action.brief);
      expect(brief.some((name) => name?.includes('3'))).toBe(false);
    });

    it('says which way a toggle is about to go, as the full name does', () => {
      expect(byId(three, deps({ archived: [] }))['bulk-archive']?.brief).toBe('Archive');
      expect(byId(three, deps({ archived: ['a', 'b', 'c'] }))['bulk-archive']?.brief).toBe('Bring back');
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

    /** It is the one that cannot be undone, so it carries the stronger of the two colours. */
    it('is marked as destructive', () => {
      expect(byId(three, deps())['bulk-delete']?.tone).toBe('danger');
    });

    it('shares the foot of the menu with archiving, which is the lesser of the two', () => {
      const toned = bulkActions(three, deps()).filter((a) => a.tone !== undefined);
      expect(toned.map((a) => [a.id, a.tone])).toEqual([
        ['bulk-archive', 'caution'],
        ['bulk-delete', 'danger'],
      ]);
    });
  });
});
