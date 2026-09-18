// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { existingSessions } = vi.hoisted(() => ({ existingSessions: vi.fn() }));
vi.mock('./sidecar', () => ({ existingSessions: (ids: string[]) => existingSessions(ids) }));

const TAGS = 'copilot-desktop.tags';

/** The module remembers that it has pruned, which is per install rather than per hook. */
async function load() {
  vi.resetModules();
  return import('./useTags');
}

beforeEach(() => {
  localStorage.clear();
  existingSessions.mockReset().mockImplementation((ids: string[]) => Promise.resolve(ids));
});

describe('normalise', () => {
  it('folds case, so Bug and bug are one tag rather than two that look alike', async () => {
    const { normalise } = await load();

    expect(normalise('Bug')).toBe('bug');
    expect(normalise('  bug  ')).toBe('bug');
  });

  it('keeps spaces, since a tag is a label rather than an identifier', async () => {
    const { normalise } = await load();

    expect(normalise('needs review')).toBe('needs review');
    expect(normalise('needs   review')).toBe('needs review');
  });
});

describe('what is true about a session', () => {
  it('starts with nothing', async () => {
    const { useTags } = await load();

    expect(renderHook(() => useTags()).result.current.tags).toEqual({});
  });

  it('tags a session and untags it again', async () => {
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.toggle('s1', 'bug'));
    expect(result.current.tags).toEqual({ s1: ['bug'] });

    act(() => result.current.toggle('s1', 'bug'));
    expect(result.current.tags).toEqual({});
  });

  it('holds several at once', async () => {
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.toggle('s1', 'bug'));
    act(() => result.current.toggle('s1', 'spike'));

    expect(result.current.tags.s1).toEqual(['bug', 'spike']);
  });

  it('keeps them alphabetical, so the same tags read the same way on every row', async () => {
    // Added in the other order: kept as typed, two rows carrying the same pair would draw
    // them differently and look unrelated down the list.
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.toggle('s1', 'unity'));
    act(() => result.current.toggle('s1', 'hades'));
    act(() => result.current.toggle('s1', 'mod'));

    expect(result.current.tags.s1).toEqual(['hades', 'mod', 'unity']);
  });

  it('sorts a store that was written in some other order', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ s1: ['unity', 'hades', 'mod'] }));
    const { useTags } = await load();

    expect(renderHook(() => useTags()).result.current.tags.s1).toEqual(['hades', 'mod', 'unity']);
  });

  it('keeps a session out of the store once its last tag goes', async () => {
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());
    act(() => result.current.toggle('s1', 'bug'));
    act(() => result.current.toggle('s1', 'spike'));

    act(() => result.current.toggle('s1', 'bug'));
    act(() => result.current.toggle('s1', 'spike'));

    expect(result.current.tags).toEqual({});
    expect(localStorage.getItem(TAGS)).toBe('{}');
  });

  it('normalises on the way in, so one spelling wins', async () => {
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.toggle('s1', '  Bug '));

    expect(result.current.tags.s1).toEqual(['bug']);
    // And the same tag differently spelled takes it off rather than adding a second.
    act(() => result.current.toggle('s1', 'BUG'));
    expect(result.current.tags).toEqual({});
  });

  it('ignores a tag that is nothing but space', async () => {
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.toggle('s1', '   '));

    expect(result.current.tags).toEqual({});
  });

  it('tags two sessions apart from each other', async () => {
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.toggle('s1', 'bug'));
    act(() => result.current.toggle('s2', 'spike'));

    expect(result.current.tags).toEqual({ s1: ['bug'], s2: ['spike'] });
  });

  it('is still tagged next time', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ s1: ['bug'] }));
    const { useTags } = await load();

    expect(renderHook(() => useTags()).result.current.tags).toEqual({ s1: ['bug'] });
  });

  it('survives a store written by something else', async () => {
    localStorage.setItem(TAGS, 'not json at all');
    const { useTags } = await load();

    expect(renderHook(() => useTags()).result.current.tags).toEqual({});
  });

  it('ignores entries that are not lists of tags', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ s1: 'bug', s2: ['spike'], s3: [] }));
    const { useTags } = await load();

    expect(renderHook(() => useTags()).result.current.tags).toEqual({ s2: ['spike'] });
  });

  it('reads a tag once however many times it was written', async () => {
    // A store written by an older version, or by hand, should not make a row say bug twice.
    localStorage.setItem(TAGS, JSON.stringify({ s1: ['bug', 'Bug', ' bug ', 'spike'] }));
    const { useTags } = await load();

    expect(renderHook(() => useTags()).result.current.tags).toEqual({ s1: ['bug', 'spike'] });
  });

  it('forgets a session that is no longer on disk', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ gone: ['bug'], here: ['spike'] }));
    existingSessions.mockResolvedValue(['here']);
    const { useTags } = await load();

    const { result } = renderHook(() => useTags());

    await waitFor(() => expect(result.current.tags).toEqual({ here: ['spike'] }));
  });
});

describe('allTags', () => {
  it('is empty when nothing is tagged', async () => {
    const { allTags } = await load();

    expect(allTags({})).toEqual([]);
  });

  it('names each tag once, however many sessions carry it', async () => {
    const { allTags } = await load();

    expect(allTags({ a: ['bug'], b: ['bug'] })).toEqual(['bug']);
  });

  it('puts the commonest first, since that is what is being reached for', async () => {
    // Names chosen so frequency and the alphabet disagree: sorted by name alone this would
    // read the other way round, and the test could not tell the two orders apart.
    const { allTags } = await load();

    expect(allTags({ a: ['zebra', 'apple'], b: ['zebra'], c: ['zebra'] })).toEqual(['zebra', 'apple']);
  });

  it('breaks a tie alphabetically rather than by whatever order the store was in', async () => {
    const { allTags } = await load();

    expect(allTags({ a: ['zebra'], b: ['apple'] })).toEqual(['apple', 'zebra']);
  });
});

/**
 * With something chosen, a count answers "what happens if I also pick this" rather than "how
 * many carry this". The two differ the moment anything is chosen, and the first is the
 * question someone with a filter already on is asking.
 */
describe('countTags once something is chosen', () => {
  const store = {
    a: ['bug', 'unity'],
    b: ['bug', 'hades'],
    c: ['unity'],
    d: ['bug', 'unity', 'hades'],
  };

  it('counts every session carrying a tag when nothing is chosen', async () => {
    const { countTags } = await load();

    expect(countTags(store)).toEqual([
      { tag: 'bug', count: 3 },
      { tag: 'unity', count: 3 },
      { tag: 'hades', count: 2 },
    ]);
  });

  it('counts what would be left, not what carries it', async () => {
    const { countTags } = await load();

    // With bug chosen: a, b and d remain. Of those, unity is on a and d, hades on b and d.
    expect(countTags(store, ['bug'])).toEqual([
      { tag: 'bug', count: 3 },
      { tag: 'hades', count: 2 },
      { tag: 'unity', count: 2 },
    ]);
  });

  it('narrows again with each one chosen', async () => {
    const { countTags } = await load();

    expect(countTags(store, ['bug', 'hades'])).toEqual([
      { tag: 'bug', count: 2 },
      { tag: 'hades', count: 2 },
      { tag: 'unity', count: 1 },
    ]);
  });

  it('leaves out one that would leave nothing', async () => {
    // With hades and unity chosen only d remains, and nothing else on d could narrow further
    // to zero - but a tag on no remaining session must not be offered as a way to empty the
    // list.
    const { countTags } = await load();

    const offered = countTags({ a: ['bug'], b: ['spike'] }, ['bug']).map(({ tag }) => tag);

    expect(offered).toEqual(['bug']);
    expect(offered).not.toContain('spike');
  });

  it('keeps a chosen tag listed even when it would leave nothing', async () => {
    // Otherwise a filter that emptied the list could not be unpicked.
    const { countTags } = await load();

    expect(countTags({}, ['gone'])).toEqual([{ tag: 'gone', count: 0 }]);
  });

  it('says a chosen tag leaves what the filter currently leaves', async () => {
    const { countTags } = await load();
    const counted = countTags(store, ['bug']);

    expect(counted.find(({ tag }) => tag === 'bug')?.count).toBe(3);
  });
});

describe('retiring a tag', () => {
  it('takes it off every session carrying it', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ a: ['bug', 'unity'], b: ['bug'], c: ['unity'] }));
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.retire('bug'));

    expect(result.current.tags).toEqual({ a: ['unity'], c: ['unity'] });
  });

  it('drops a session left with nothing, so the store does not keep empty entries', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ a: ['bug'] }));
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.retire('bug'));

    expect(result.current.tags).toEqual({});
    expect(localStorage.getItem(TAGS)).toBe('{}');
  });

  it('is still gone next time', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ a: ['bug', 'unity'] }));
    const first = await load();
    const opened = renderHook(() => first.useTags());
    act(() => opened.result.current.retire('bug'));

    const { useTags } = await load();
    expect(renderHook(() => useTags()).result.current.tags).toEqual({ a: ['unity'] });
  });

  it('normalises, so retiring Bug retires bug', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ a: ['bug'] }));
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.retire('  BUG '));

    expect(result.current.tags).toEqual({});
  });

  it('leaves everything else alone', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ a: ['bug', 'unity', 'hades'] }));
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.retire('unity'));

    expect(result.current.tags).toEqual({ a: ['bug', 'hades'] });
  });

  it('does nothing for a name nobody used', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ a: ['bug'] }));
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.retire('never-used'));

    expect(result.current.tags).toEqual({ a: ['bug'] });
  });

  it('ignores a name that is nothing but space', async () => {
    localStorage.setItem(TAGS, JSON.stringify({ a: ['bug'] }));
    const { useTags } = await load();
    const { result } = renderHook(() => useTags());

    act(() => result.current.retire('   '));

    expect(result.current.tags).toEqual({ a: ['bug'] });
  });
});