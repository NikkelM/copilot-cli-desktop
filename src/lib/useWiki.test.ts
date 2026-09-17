// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWiki } from './useWiki';
import type { WikiPage } from '../../shared/protocol';

const { listWikiPages, readWikiPage } = vi.hoisted(() => ({
  listWikiPages: vi.fn(),
  readWikiPage: vi.fn(),
}));

vi.mock('./sidecar', () => ({
  listWikiPages: () => listWikiPages(),
  readWikiPage: (path: string) => readWikiPage(path),
}));

const pages: WikiPage[] = [
  { path: 'Home.md', title: 'Home' },
  { path: 'index.md', title: 'Index' },
  { path: 'projects/README.md', title: 'Projects' },
];

beforeEach(() => {
  listWikiPages.mockReset().mockResolvedValue(pages);
  readWikiPage.mockReset().mockImplementation((path: string) => Promise.resolve({ path, body: `body of ${path}` }));
});

describe('holding the wiki open', () => {
  /** Most sessions are worked in without the wiki being looked at, and a walk nobody asked for is a walk. */
  it('reads nothing until it is opened', () => {
    renderHook(({ open }) => useWiki(open), { initialProps: { open: false } });

    expect(listWikiPages).not.toHaveBeenCalled();
  });

  it('reads the pages once it is opened', async () => {
    const { result } = renderHook(() => useWiki(true));

    await waitFor(() => expect(result.current.pages).toEqual(pages));
  });

  it('reads them once however often it is opened', async () => {
    const { result, rerender } = renderHook(({ open }) => useWiki(open), { initialProps: { open: true } });
    await waitFor(() => expect(result.current.pages).toEqual(pages));

    rerender({ open: false });
    rerender({ open: true });

    expect(listWikiPages).toHaveBeenCalledTimes(1);
  });

  it('says so when the wiki cannot be read', async () => {
    listWikiPages.mockRejectedValue(new Error('no such directory'));
    const { result } = renderHook(() => useWiki(true));

    await waitFor(() => expect(result.current.failed).toContain('no such directory'));
  });
});

describe('the page a reader starts on', () => {
  it('opens the index when there is one', async () => {
    const { result } = renderHook(() => useWiki(true));

    await waitFor(() => expect(result.current.page?.path).toBe('index.md'));
  });

  /** A knowledge base may be laid out around any of these, so the entry is chosen from what is there. */
  it('falls back to the home page', async () => {
    listWikiPages.mockResolvedValue([{ path: 'Home.md', title: 'Home' }]);
    const { result } = renderHook(() => useWiki(true));

    await waitFor(() => expect(result.current.page?.path).toBe('Home.md'));
  });

  it('opens the first page when it recognises none of them', async () => {
    listWikiPages.mockResolvedValue([{ path: 'areas/only.md', title: 'Only' }]);
    const { result } = renderHook(() => useWiki(true));

    await waitFor(() => expect(result.current.page?.path).toBe('areas/only.md'));
  });

  it('opens nothing when the wiki is empty', async () => {
    listWikiPages.mockResolvedValue([]);
    const { result } = renderHook(() => useWiki(true));

    await waitFor(() => expect(result.current.pages).toEqual([]));
    expect(readWikiPage).not.toHaveBeenCalled();
  });
});

describe('moving between pages', () => {
  it('reads the page it is sent to', async () => {
    const { result } = renderHook(() => useWiki(true));
    await waitFor(() => expect(result.current.page?.path).toBe('index.md'));

    act(() => result.current.go('projects/README.md'));

    await waitFor(() => expect(result.current.page?.path).toBe('projects/README.md'));
  });

  it('goes back to where it came from', async () => {
    const { result } = renderHook(() => useWiki(true));
    await waitFor(() => expect(result.current.page?.path).toBe('index.md'));

    act(() => result.current.go('projects/README.md'));
    await waitFor(() => expect(result.current.canGoBack).toBe(true));
    act(() => result.current.back());

    await waitFor(() => expect(result.current.page?.path).toBe('index.md'));
    expect(result.current.canGoBack).toBe(false);
  });

  it('offers no way back from where it started', async () => {
    const { result } = renderHook(() => useWiki(true));
    await waitFor(() => expect(result.current.page?.path).toBe('index.md'));

    expect(result.current.canGoBack).toBe(false);
  });

  /** Following a link to the page already open would otherwise fill the trail with it. */
  it('does not remember standing still', async () => {
    const { result } = renderHook(() => useWiki(true));
    await waitFor(() => expect(result.current.page?.path).toBe('index.md'));

    act(() => result.current.go('index.md'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canGoBack).toBe(false);
  });

  it('says so when a page has gone', async () => {
    const { result } = renderHook(() => useWiki(true));
    await waitFor(() => expect(result.current.page?.path).toBe('index.md'));
    readWikiPage.mockResolvedValue(null);

    act(() => result.current.go('gone.md'));

    await waitFor(() => expect(result.current.failed).toContain('gone.md'));
  });

  /**
   * A reader clicking through several links leaves earlier reads in flight, and a slow one
   * landing last would show a page nobody is on any more.
   */
  it('ignores a page that arrives after another was asked for', async () => {
    const { result } = renderHook(() => useWiki(true));
    await waitFor(() => expect(result.current.page?.path).toBe('index.md'));

    let settleSlow!: (page: unknown) => void;
    readWikiPage.mockImplementationOnce(() => new Promise((resolve) => (settleSlow = resolve)));
    act(() => result.current.go('projects/README.md'));

    readWikiPage.mockImplementation((path: string) => Promise.resolve({ path, body: 'quick' }));
    act(() => result.current.go('Home.md'));
    await waitFor(() => expect(result.current.page?.path).toBe('Home.md'));

    // Awaited, so the late reply is delivered rather than left pending past the assertion.
    await act(async () => {
      settleSlow({ path: 'projects/README.md', body: 'slow' });
      await Promise.resolve();
    });

    expect(result.current.page?.path).toBe('Home.md');
  });
});
