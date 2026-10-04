// @vitest-environment jsdom
import { act, render, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useOnScreen } from './useOnScreen';

/**
 * A stand-in for the browser's observer, which jsdom does not have.
 *
 * Holds what it was told to watch and lets a test say a row came into view, which is the
 * only part of the real thing the hook depends on.
 */
class FakeObserver {
  static live: FakeObserver[] = [];
  readonly watching = new Set<Element>();
  readonly options: IntersectionObserverInit | undefined;
  disconnected = false;
  private readonly tell: (entries: { target: Element; isIntersecting: boolean }[]) => void;

  constructor(tell: (entries: { target: Element; isIntersecting: boolean }[]) => void, options?: IntersectionObserverInit) {
    this.tell = tell;
    this.options = options;
    FakeObserver.live.push(this);
  }

  observe(node: Element) {
    this.watching.add(node);
  }

  unobserve(node: Element) {
    this.watching.delete(node);
  }

  disconnect() {
    this.disconnected = true;
    this.watching.clear();
  }

  /** Say what a reader can and cannot see now. */
  show(...entries: [Element, boolean][]) {
    act(() => this.tell(entries.map(([target, isIntersecting]) => ({ target, isIntersecting }))));
  }
}

const row = (name: string) => {
  const node = document.createElement('div');
  node.dataset.name = name;
  return node;
};

const latest = () => FakeObserver.live[FakeObserver.live.length - 1]!;

beforeEach(() => {
  FakeObserver.live = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
});

afterEach(() => {
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe('which rows a reader can see', () => {
  it('starts with none, before anything has been drawn', () => {
    const { result } = renderHook(() => useOnScreen());

    expect(result.current.visible).toEqual([]);
  });

  it('names a row once it comes into view', () => {
    const { result } = renderHook(() => useOnScreen());
    const node = row('a');
    act(() => result.current.watch('a', node));

    latest().show([node, true]);

    expect(result.current.visible).toEqual(['a']);
  });

  it('does not name a row that is watched but still below the fold', () => {
    const { result } = renderHook(() => useOnScreen());
    const node = row('a');
    act(() => result.current.watch('a', node));

    latest().show([node, false]);

    expect(result.current.visible).toEqual([]);
  });

  it('forgets a row once it is scrolled past', () => {
    const { result } = renderHook(() => useOnScreen());
    const node = row('a');
    act(() => result.current.watch('a', node));
    latest().show([node, true]);

    latest().show([node, false]);

    expect(result.current.visible).toEqual([]);
  });

  it('holds several rows at once', () => {
    const { result } = renderHook(() => useOnScreen());
    const [one, two] = [row('a'), row('b')];
    act(() => {
      result.current.watch('a', one);
      result.current.watch('b', two);
    });

    latest().show([one, true], [two, true]);

    expect([...result.current.visible].sort()).toEqual(['a', 'b']);
  });

  it('forgets a row that leaves the list entirely', () => {
    const { result } = renderHook(() => useOnScreen());
    const node = row('a');
    act(() => result.current.watch('a', node));
    latest().show([node, true]);

    // What React does when a row is removed: the same callback, with nothing in it.
    act(() => result.current.watch('a', null));

    expect(result.current.visible).toEqual([]);
    expect(latest().watching.size).toBe(0);
  });

  it('ignores an entry for something it was never told about', () => {
    const { result } = renderHook(() => useOnScreen());
    act(() => result.current.watch('a', row('a')));

    latest().show([row('a stranger'), true]);

    expect(result.current.visible).toEqual([]);
  });

  it('asks about rows a little before they are reached', () => {
    const { result } = renderHook(() => useOnScreen());
    act(() => result.current.watch('a', row('a')));

    expect(latest().options?.rootMargin).toBe('200px');
  });

  it('stops watching when the sidebar goes away', () => {
    const { result, unmount } = renderHook(() => useOnScreen());
    act(() => result.current.watch('a', row('a')));

    unmount();

    expect(latest().disconnected).toBe(true);
  });

  it('builds nothing at all until there is a row to watch', () => {
    renderHook(() => useOnScreen());

    expect(FakeObserver.live).toHaveLength(0);
  });
});

describe('not redrawing for nothing', () => {
  it('keeps the same list when a row it already holds is seen again', () => {
    const { result } = renderHook(() => useOnScreen());
    const node = row('a');
    act(() => result.current.watch('a', node));
    latest().show([node, true]);
    const before = result.current.visible;

    latest().show([node, true]);

    expect(result.current.visible).toBe(before);
  });

  it('keeps the same list when a row it never held leaves the fold', () => {
    const { result } = renderHook(() => useOnScreen());
    const node = row('a');
    act(() => result.current.watch('a', node));
    const before = result.current.visible;

    latest().show([node, false]);

    expect(result.current.visible).toBe(before);
  });

  it('hands back the same watcher across renders, so rows are not rewatched', () => {
    const { result, rerender } = renderHook(() => useOnScreen());
    const before = result.current.watch;

    rerender();

    expect(result.current.watch).toBe(before);
  });
});

describe('where there is nothing to watch with', () => {
  it('still draws, rather than failing on a browser without an observer', () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

    const { result } = renderHook(() => useOnScreen());
    act(() => result.current.watch('a', row('a')));

    expect(result.current.visible).toEqual([]);
  });
});

/**
 * How the sidebar actually uses this: a parent holds the hook and children carry the refs.
 *
 * React attaches a child's ref before it runs a parent's effect, which is the order that
 * matters here and the order `renderHook` on its own never produces.
 */
describe('used the way the sidebar uses it', () => {
  function List({ ids }: { ids: string[] }) {
    const { watch, visible } = useOnScreen();
    // The stable per-row callback the sidebar hands out, which is the hook's contract.
    const refs = useRef(new Map<string, (node: Element | null) => void>());
    const rowRef = (id: string) => {
      let ref = refs.current.get(id);
      if (!ref) {
        ref = (node: Element | null) => watch(id, node);
        refs.current.set(id, ref);
      }
      return ref;
    };

    return (
      <div>
        <p data-testid="visible">{visible.join(',')}</p>
        {ids.map((id) => (
          <div key={id} data-testid={id} ref={rowRef(id)} />
        ))}
      </div>
    );
  }

  it('watches rows that were drawn before it had anything to watch them with', () => {
    render(<List ids={['a']} />);

    expect(latest().watching.size).toBe(1);
  });

  it('names a row that was drawn before the observer existed', () => {
    const { getByTestId } = render(<List ids={['a']} />);

    latest().show([getByTestId('a'), true]);

    expect(getByTestId('visible').textContent).toBe('a');
  });

  it('watches a row added to the list later', () => {
    const { rerender } = render(<List ids={['a']} />);

    rerender(<List ids={['a', 'b']} />);

    expect(latest().watching.size).toBe(2);
  });
});
