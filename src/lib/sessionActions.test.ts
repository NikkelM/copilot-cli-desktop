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
  pinned: [],
  togglePin: vi.fn(),
  working: new Set(),
  unload: vi.fn(),
  copy: vi.fn(),
  openFolder: vi.fn(),
  ...over,
});

const byId = (session: SessionSummary, d: SessionActionDeps) =>
  Object.fromEntries(sessionActions(session, d).map((a) => [a.id, a]));

describe('sessionActions', () => {
  it('offers only what the app can do today', () => {
    expect(sessionActions(session(), deps()).map((a) => a.id)).toEqual([
      'pin',
      'unload',
      'copy-id',
      'folder',
    ]);
  });

  describe('pinning', () => {
    it('offers to pin a session that is not pinned', () => {
      expect(byId(session(), deps()).pin.label).toBe('Pin to top');
    });

    it('offers to unpin one that is', () => {
      expect(byId(session(), deps({ pinned: ['abc'] })).pin.label).toBe('Unpin');
    });

    it('toggles the session it was opened on', () => {
      const togglePin = vi.fn();
      byId(session({ sessionId: 'xyz' }), deps({ togglePin })).pin.run();
      expect(togglePin).toHaveBeenCalledWith('xyz');
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

  it('copies the session id', () => {
    const copy = vi.fn();
    byId(session({ sessionId: 'the-id' }), deps({ copy }))['copy-id'].run();
    expect(copy).toHaveBeenCalledWith('the-id');
  });
});
