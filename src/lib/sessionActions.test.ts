import { describe, expect, it, vi } from 'vitest';
import { sessionActions, type SessionActionDeps } from './sessionActions';
import type { SessionSummary } from '../../shared/protocol';

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    sessionId: 'abc',
    title: 'A session',
    cwd: 'C:\\work',
    repository: null,
    branch: null,
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    loaded: false,
    ...over,
  }) as SessionSummary;

const deps = (over: Partial<SessionActionDeps> = {}): SessionActionDeps => ({
  favourites: [],
  toggleFavourite: vi.fn(),
  archived: [],
  toggleArchived: vi.fn(),
  working: new Set(),
  unload: vi.fn(),
  copy: vi.fn(),
  openFolder: vi.fn(),
  remove: vi.fn(),
  ...over,
});

const byId = (session: SessionSummary, d: SessionActionDeps) =>
  Object.fromEntries(sessionActions(session, d).map((a) => [a.id, a]));

describe('sessionActions', () => {
  it('offers only what the app can do today', () => {
    expect(sessionActions(session(), deps()).map((a) => a.id)).toEqual([
      'favourite',
      'unload',
      'archive',
      'copy-id',
      'folder',
      'delete',
    ]);
  });

  describe('favouriting', () => {
    it('offers to favourite a session that is not', () => {
      expect(byId(session(), deps()).favourite.label).toBe('Favourite');
    });

    it('offers to unfavourite one that is', () => {
      expect(byId(session(), deps({ favourites: ['abc'] })).favourite.label).toBe('Unfavourite');
    });

    it('toggles the session it was opened on', () => {
      const toggleFavourite = vi.fn();
      byId(session({ sessionId: 'xyz' }), deps({ toggleFavourite })).favourite.run();
      expect(toggleFavourite).toHaveBeenCalledWith('xyz');
    });
  });

  describe('unloading', () => {
    it('unloads a loaded session that is idle', () => {
      const unload = vi.fn();
      const action = byId(session({ loaded: true }), deps({ unload })).unload;

      expect(action.refused).toBeUndefined();
      action.run();
      expect(unload).toHaveBeenCalledWith('abc');
    });

    it('refuses a session that is not loaded, since it already costs nothing', () => {
      expect(byId(session({ loaded: false }), deps()).unload.refused).toMatch(/already unloaded/i);
    });

    it('refuses a session mid-turn rather than appearing to do nothing', () => {
      // The runtime returns early for a busy session, so without this the reader clicks and
      // watches nothing happen (#107).
      const action = byId(session({ loaded: true }), deps({ working: new Set(['abc']) })).unload;
      expect(action.refused).toMatch(/still working/i);
    });

    it('is not confused by a different session working', () => {
      const action = byId(session({ loaded: true }), deps({ working: new Set(['other']) })).unload;
      expect(action.refused).toBeUndefined();
    });
  });

  describe('the working folder', () => {
    it('opens the folder the session was started in', () => {
      const openFolder = vi.fn();
      byId(session({ cwd: 'C:\\repo' }), deps({ openFolder })).folder.run();
      expect(openFolder).toHaveBeenCalledWith('C:\\repo');
    });

    it('refuses when the session has no folder', () => {
      const openFolder = vi.fn();
      const action = byId(session({ cwd: null }), deps({ openFolder })).folder;

      expect(action.refused).toMatch(/not started in a folder/i);
      action.run();
      expect(openFolder).not.toHaveBeenCalled();
    });
  });

  describe('archiving', () => {
    it('offers to put away one that is not', () => {
      expect(byId(session(), deps()).archive.label).toBe('Archive');
    });

    it('offers to take back one that is', () => {
      expect(byId(session(), deps({ archived: ['abc'] })).archive.label).toBe('Take out of the archive');
    });

    it('marks the session it was opened on', () => {
      const toggleArchived = vi.fn();
      byId(session({ sessionId: 'done' }), deps({ toggleArchived })).archive.run();

      expect(toggleArchived).toHaveBeenCalledExactlyOnceWith('done');
    });

    it('asks nothing first, since nothing on disk changes', () => {
      // Unlike deleting: the group is one press from open and the session is still there.
      expect(byId(session(), deps()).archive.refused).toBeUndefined();
    });

    it('refuses a session mid-turn, because archiving lets it go', () => {
      const action = byId(session({ loaded: true }), deps({ working: new Set(['abc']) })).archive;
      expect(action.refused).toMatch(/still working/i);
    });

    it('is not one of the actions that loses something', () => {
      expect(byId(session(), deps()).archive.destructive).toBeUndefined();
    });
  });
  describe('deleting', () => {
    it('hands the session up rather than deleting it here', () => {
      // Confirming belongs to the caller: this list has no way to ask anything.
      const remove = vi.fn();
      const target = session({ sessionId: 'doomed' });
      byId(target, deps({ remove })).delete.run();

      expect(remove).toHaveBeenCalledExactlyOnceWith(target);
    });

    it('refuses a session mid-turn', () => {
      const action = byId(session({ loaded: true }), deps({ working: new Set(['abc']) })).delete;
      expect(action.refused).toMatch(/still working/i);
    });

    it('deletes a session that is not loaded, since the log is what goes', () => {
      expect(byId(session({ loaded: false }), deps()).delete.refused).toBeUndefined();
    });

    it('is marked apart from the actions that lose nothing', () => {
      const actions = sessionActions(session(), deps());
      expect(actions.filter((a) => a.destructive).map((a) => a.id)).toEqual(['delete']);
    });
  });

  it('copies the session id', () => {
    const copy = vi.fn();
    byId(session({ sessionId: 'the-id' }), deps({ copy }))['copy-id'].run();
    expect(copy).toHaveBeenCalledWith('the-id');
  });
});
