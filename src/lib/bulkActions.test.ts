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
  load: vi.fn(),
  remove: vi.fn(),
  exportAll: vi.fn(),
  done: vi.fn(),
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
      'bulk-load',
      'bulk-export',
      'bulk-archive',
      'bulk-delete',
    ]);
  });

  it('offers to release a set that is in memory instead of to load it', () => {
    const warm = [session('a', { loaded: true }), session('b', { loaded: true })];

    expect(bulkActions(warm, deps()).map((a) => a.id)).toEqual([
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
      expect(byId(three, deps({ archived: ['a', 'b', 'c'] }))['bulk-archive']?.brief).toBe('Unarchive');
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

      expect(byId(three, d)['bulk-archive']?.label).toBe('Unarchive 3 sessions');
    });

    it('only moves the ones that are not already away', () => {
      const d = deps({ archived: ['b'] });

      byId(three, d)['bulk-archive']?.run();

      expect(d.toggleArchived).toHaveBeenCalledTimes(2);
      expect(d.toggleArchived).not.toHaveBeenCalledWith('b');
    });

    /**
     * The rows have left the list - archived sessions fold into a group of their own - so a
     * selection that stayed behind would be counting rows nobody can see.
     */
    it('lets the selection go once the set has moved', () => {
      const d = deps();

      byId(three, d)['bulk-archive']?.run();

      expect(d.done).toHaveBeenCalledOnce();
    });

    it('lets it go when they are brought back as well', () => {
      const d = deps({ archived: ['a', 'b', 'c'] });

      byId(three, d)['bulk-archive']?.run();

      expect(d.done).toHaveBeenCalledOnce();
    });

    /** Deleting and exporting ask something first, and clear up when they are answered. */
    it('is the only one that clears the selection where it stands', () => {
      const warm = [session('a', { loaded: true }), session('b', { loaded: true })];
      for (const id of ['bulk-unload', 'bulk-export', 'bulk-delete']) {
        const d = deps();
        const action = byId(warm, d)[id];
        expect(action, `${id} should be in the list`).toBeDefined();
        action?.run();
        expect(d.done, `${id} should leave the selection alone`).not.toHaveBeenCalled();
      }
    });
  });

  describe('unloading', () => {
    const mixed = [session('a', { loaded: true }), session('b'), session('c', { loaded: true })];

    it('counts only the ones that are in memory', () => {
      expect(byId(mixed, deps())['bulk-unload']?.label).toBe('Unload 2 sessions from memory');
    });

    it('releases only those', () => {
      const d = deps();
      const some = [session('a', { loaded: true }), session('b')];

      byId(some, d)['bulk-unload']?.run();

      expect(d.unload).toHaveBeenCalledOnce();
      expect(d.unload).toHaveBeenCalledWith('a');
    });

    it('is offered where one of them is in memory', () => {
      const some = [session('a', { loaded: true }), session('b')];

      expect(byId(some, deps())['bulk-unload']?.refused).toBeUndefined();
    });

    it('is not there at all where none of them is', () => {
      expect(byId(three, deps())['bulk-unload']).toBeUndefined();
    });
  });

  /**
   * A set with nothing in memory was offered a greyed Unload, which is a button that exists
   * to say no. Where every one of them is cold there is an obvious other thing to mean.
   */
  describe('loading', () => {
    it('is offered in place of unloading where the whole set is cold', () => {
      expect(byId(three, deps())['bulk-load']?.label).toBe('Load 3 sessions into memory');
    });

    it('resumes every one of them', () => {
      const d = deps();

      byId(three, d)['bulk-load']?.run();

      expect(d.load).toHaveBeenCalledTimes(3);
      expect(d.load).toHaveBeenCalledWith('b');
    });

    it('has a short name of its own', () => {
      expect(byId(three, deps())['bulk-load']?.brief).toBe('Load');
    });

    /**
     * Loading is the expensive direction, a process each. A set that is part loaded has no
     * unambiguous reading, while unloading the ones that are loaded always does.
     */
    it('is not offered where any of them is already in memory', () => {
      const some = [session('a', { loaded: true }), session('b'), session('c')];

      expect(byId(some, deps())['bulk-load']).toBeUndefined();
    });

    it('takes the place of unloading rather than being added beside it', () => {
      expect(bulkActions(three, deps())).toHaveLength(bulkActions([session('a', { loaded: true })], deps()).length);
    });

    /** The rows stay where they are - in memory is a group nobody has folded away. */
    it('leaves the selection alone', () => {
      const d = deps();

      byId(three, d)['bulk-load']?.run();

      expect(d.done).not.toHaveBeenCalled();
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
