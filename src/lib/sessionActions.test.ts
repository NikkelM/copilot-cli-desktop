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
  tag: vi.fn(),
  exportTo: vi.fn(),
  rename: vi.fn(),
  working: new Set(),
  unload: vi.fn(),
  load: vi.fn(),
  copy: vi.fn(),
  openDirectory: vi.fn(),
  showSubagents: vi.fn(),
  hasNoSubagents: () => false,
  fork: vi.fn(),
  remove: vi.fn(),
  ...over,
});

const byId = (session: SessionSummary, d: SessionActionDeps) =>
  Object.fromEntries(sessionActions(session, d).map((a) => [a.id, a]));

describe('sessionActions', () => {
  it('offers only what the app can do today', () => {
    expect(sessionActions(session(), deps()).map((a) => a.id)).toEqual([
      'favourite',
      'memory',
      'rename',
      'tag',
      'export',
      'fork',
      'archive',
      'subagents',
      'copy-id',
      'directory',
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

  describe('loading and unloading', () => {
    it('unloads a loaded session that is idle', () => {
      const unload = vi.fn();
      const action = byId(session({ loaded: true }), deps({ unload })).memory;

      expect(action.refused).toBeUndefined();
      action.run();
      expect(unload).toHaveBeenCalledWith('abc');
    });

    it('offers to bring in a session that is not loaded, rather than refusing', () => {
      // The opposite of unloading, and the reason evicting exists: a session nobody has
      // asked anything of is free, so waking one is a deliberate purchase.
      const load = vi.fn();
      const action = byId(session({ loaded: false }), deps({ load })).memory;

      expect(action.label).toBe('Load into memory');
      expect(action.refused).toBeUndefined();
      action.run();
      expect(load).toHaveBeenCalledWith('abc');
    });

    it('says which way it goes, since it is the same row either way', () => {
      expect(byId(session({ loaded: true }), deps()).memory.label).toBe('Unload from memory');
      expect(byId(session({ loaded: false }), deps()).memory.label).toBe('Load into memory');
    });

    it('does not unload a session it was asked to load', () => {
      const unload = vi.fn();
      byId(session({ loaded: false }), deps({ unload })).memory.run();

      expect(unload).not.toHaveBeenCalled();
    });

    it('never refuses a session that is not loaded, since no turn can be running on one', () => {
      const action = byId(session({ loaded: false }), deps({ working: new Set(['abc']) })).memory;

      expect(action.refused).toBeUndefined();
    });

    it('refuses a session mid-turn rather than appearing to do nothing', () => {
      // The runtime returns early for a busy session, so without this the reader clicks and
      // watches nothing happen (#107).
      const action = byId(session({ loaded: true }), deps({ working: new Set(['abc']) })).memory;
      expect(action.refused).toMatch(/still working/i);
    });

    it('is not confused by a different session working', () => {
      const action = byId(session({ loaded: true }), deps({ working: new Set(['other']) })).memory;
      expect(action.refused).toBeUndefined();
    });
  });

  /** The tasks a session delegated, which the sidebar cannot reach on its own (#228). */
  describe('delegated tasks', () => {
    it('opens them for the session it was asked about', () => {
      const showSubagents = vi.fn();
      byId(session({ sessionId: 's7' }), deps({ showSubagents })).subagents.run();
      expect(showSubagents).toHaveBeenCalledWith('s7');
    });

    it('is offered where nothing is known about what a session delegated', () => {
      expect(byId(session(), deps({ hasNoSubagents: () => false })).subagents.refused).toBeUndefined();
    });

    /** Refused only where the whole log was read and held nothing, which is certain. */
    it('is refused where the session is known to have delegated nothing', () => {
      const action = byId(session(), deps({ hasNoSubagents: () => true })).subagents;

      expect(action.refused).toMatch(/not delegated anything/i);
    });
  });

  describe('the working directory', () => {
    it('opens the directory the session was started in', () => {
      const openDirectory = vi.fn();
      byId(session({ cwd: 'C:\\repo' }), deps({ openDirectory })).directory.run();
      expect(openDirectory).toHaveBeenCalledWith('C:\\repo');
    });

    it('refuses when the session has no directory', () => {
      const openDirectory = vi.fn();
      const action = byId(session({ cwd: null }), deps({ openDirectory })).directory;

      expect(action.refused).toMatch(/no working directory/i);
      action.run();
      expect(openDirectory).not.toHaveBeenCalled();
    });
  });

  describe('archiving', () => {
    it('offers to put away one that is not', () => {
      expect(byId(session(), deps()).archive.label).toBe('Archive');
    });

    it('offers to take back one that is', () => {
      expect(byId(session(), deps({ archived: ['abc'] })).archive.label).toBe('Unarchive');
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

  /**
   * Forking has to open the session it copies, because forking one the CLI is not holding
   * empties the original instead of copying it (#196). This app opens nothing it is not
   * asked to, so that cost is said before it is paid.
   */
  describe('forking', () => {
    it('hands the session up rather than forking it here', () => {
      const fork = vi.fn();
      const target = session({ sessionId: 'source' });
      byId(target, deps({ fork })).fork.run();

      expect(fork).toHaveBeenCalledExactlyOnceWith(target);
    });

    it('says that a session not in memory will be opened first', () => {
      expect(byId(session({ loaded: false }), deps()).fork.label).toMatch(/loads it first/i);
    });

    it('says nothing about loading one that is already loaded', () => {
      expect(byId(session({ loaded: true }), deps()).fork.label).toBe('Fork session');
    });

    // The copy would stop partway through a reply nobody sent.
    it('refuses a session mid-turn', () => {
      const action = byId(session({ loaded: true }), deps({ working: new Set(['abc']) })).fork;
      expect(action.refused).toMatch(/still working/i);
    });

    it('forks a session that is not loaded, which is the whole point of saying so', () => {
      expect(byId(session({ loaded: false }), deps()).fork.refused).toBeUndefined();
    });

    // It takes nothing away: the source is left exactly as it was.
    it('is not one of the actions that loses something', () => {
      expect(byId(session(), deps()).fork.destructive).toBeUndefined();
    });
  });

  it('copies the session id', () => {
    const copy = vi.fn();
    byId(session({ sessionId: 'the-id' }), deps({ copy }))['copy-id'].run();
    expect(copy).toHaveBeenCalledWith('the-id');
  });
});

/** Moving a session to another machine, which is about that session (#63). */
describe('exporting a session', () => {
  it('hands the session over to be written out', () => {
    const d = deps();
    const chosen = session();

    byId(chosen, d)['export']?.run();

    expect(d.exportTo).toHaveBeenCalledWith(chosen);
  });

  it('is offered whether or not the session is loaded', () => {
    expect(byId(session({ loaded: true }), deps())['export']?.refused).toBeUndefined();
    expect(byId(session({ loaded: false }), deps())['export']?.refused).toBeUndefined();
  });

  /** Nothing is lost by writing a copy out, so it is not one of the ones drawn apart. */
  it('is not treated as destructive', () => {
    expect(byId(session(), deps())['export']?.destructive).toBeFalsy();
  });
});
