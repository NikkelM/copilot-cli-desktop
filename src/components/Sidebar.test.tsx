// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import { Sidebar } from './Sidebar';
import type { SessionSummary } from '../../shared/protocol';

const findSessions = vi.hoisted(() => vi.fn());
vi.mock('../lib/sidecar', () => ({ findSessions: (prefix: string) => findSessions(prefix) }));

beforeEach(() => findSessions.mockReset().mockResolvedValue({ sessions: [] }));

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    sessionId: '00000000-0000-0000-0000-000000000000',
    title: 'Untitled',
    cwd: null,
    repository: null,
    branch: null,
    updatedAt: '2026-01-01T00:00:00Z',
    turns: 1,
    loaded: false,
    ...over,
  }) as SessionSummary;

const sessions = [
  session({ sessionId: 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8', title: 'Biomes', repository: 'NikkelM/Hades' }),
  session({ sessionId: '9ec04ce0-1361-4e11-ae34-9f8747cbac64', title: 'Desktop app', cwd: 'C:\\work\\desktop' }),
];

const show = (query?: string) => {
  render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
      onWiki={() => {}} creating={false} activity={{}} />);
  return query ? userEvent.type(screen.getByRole('searchbox'), query) : Promise.resolve();
};

const titles = () => screen.getAllByRole('button').map((b) => b.textContent);

describe('Sidebar filtering', () => {
  it.each([
    ['a title', 'biomes', 'Biomes'],
    ['a repository', 'hades', 'Biomes'],
    ['a directory', 'desktop', 'Desktop app'],
  ])('matches %s', async (_what, query, expected) => {
    await show(query);

    expect(titles().filter((t) => t?.includes(expected))).toHaveLength(1);
  });

  /**
   * An id is quoted by its first characters everywhere it appears - CLI output, the name of
   * a state directory, a commit trailer - so pasting one in is a natural way to find the
   * session it belongs to.
   */
  describe('by session id', () => {
    it('matches a whole id', async () => {
      await show('9ec04ce0-1361-4e11-ae34-9f8747cbac64');

      expect(titles().some((t) => t?.includes('Desktop app'))).toBe(true);
      expect(titles().some((t) => t?.includes('Biomes'))).toBe(false);
    });

    it('matches the first characters, as an id is usually written', async () => {
      await show('f1ec2c40');

      expect(titles().some((t) => t?.includes('Biomes'))).toBe(true);
      expect(titles().some((t) => t?.includes('Desktop app'))).toBe(false);
    });

    it('ignores case, as the rest of the filter does', async () => {
      await show('F1EC2C40');

      expect(titles().some((t) => t?.includes('Biomes'))).toBe(true);
    });

    // Matching an id anywhere would make a short query match almost everything, since an id
    // is thirty-two characters of hex.
    it('does not match the middle of an id', async () => {
      await show('9eb5');

      expect(titles().some((t) => t?.includes('Biomes'))).toBe(false);
    });
  });
});

/**
 * The list leaves out sessions with no title and no turns - on a real store, 99 of 182 -
 * because almost all are crashed starts. But an id names one session, and a reader who has
 * one in hand is asking about that session specifically: telling them nothing matches, for
 * something sitting on disk, reads as data loss.
 */
describe('Sidebar finding a session the list hides', () => {
  const hidden = session({ sessionId: '0bd2d807-816c-46ce-8e8e-20c74b9be864', title: null });

  it('offers a session found by id when nothing in the list matches', async () => {
    findSessions.mockResolvedValue({ sessions: [hidden] });
    await show('0bd2d807');

    await vi.waitFor(() => expect(screen.getByText('Not in the list')).toBeTruthy());
    expect(titles().some((t) => t?.includes('Untitled session'))).toBe(true);
  });

  it('hands the summary up with the id, since the caller cannot look it up', async () => {
    findSessions.mockResolvedValue({ sessions: [hidden] });
    const onSelect = vi.fn();
    render(
      <Sidebar sessions={sessions} selectedId={null} onSelect={onSelect} onCreate={() => {}}
      onWiki={() => {}} creating={false} activity={{}} />,
    );
    await userEvent.type(screen.getByRole('searchbox'), '0bd2d807');

    await vi.waitFor(() => expect(screen.getByText('Not in the list')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /Untitled session/ }));

    expect(onSelect).toHaveBeenCalledWith('0bd2d807-816c-46ce-8e8e-20c74b9be864', hidden);
  });

  // The list is the hot path and this is not, so it must not run for ordinary typing.
  it.each([
    // Id-shaped, but the list already answered it - which is the case the gate exists for.
    ['an id the list already matched', 'f1ec2c40'],
    ['a query too short to be an id', '0bd2'],
    ['a query that cannot be an id', 'desktop-app'],
  ])('asks nothing for %s', async (_what, query) => {
    await show(query);

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(findSessions).not.toHaveBeenCalled();
  });

  it('still says nothing matched when the lookup finds nothing either', async () => {
    await show('abcdef01');

    await vi.waitFor(() => expect(findSessions).toHaveBeenCalled());
    expect(screen.getByText('No sessions match that filter.')).toBeTruthy();
  });
});

/**
 * Loaded sessions are the only ones that cost anything, which is the central idea of the
 * app. They were marked by a four-pixel dot that explained neither why they sat at the top
 * nor what was different about them.
 */
describe('Sidebar grouping', () => {
  const grouped = [
    session({ sessionId: 'a', title: 'Working', loaded: true }),
    session({ sessionId: 'b', title: 'Also working', loaded: true }),
    session({ sessionId: 'c', title: 'Cold' }),
  ];

  const show = (props: Record<string, unknown> = {}) =>
    render(
      <Sidebar
        sessions={grouped}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      onWiki={() => {}}
        creating={false}
        activity={{}}
        {...props}
      />,
    );

  it('names the group holding memory', () => {
    show();
    expect(screen.getByText('In memory')).toBeTruthy();
  });

  it('marks where the rest of the list begins', () => {
    show();
    expect(screen.getByText('Not loaded')).toBeTruthy();
  });

  // Past the cap the least recently used session is evicted, which is worth seeing coming.
  it('marks the group full once it is at the cap', () => {
    show({ maxLoaded: 2 });
    expect(screen.getByText('2 · full')).toBeTruthy();
  });

  /**
   * "1 of 2" read as a total rather than a cap, so a session that had gone to sleep after
   * ten minutes idle looked deleted. Below the cap the number alone is the honest thing.
   */
  it('shows the count alone while there is room', () => {
    show({ maxLoaded: 3 });
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText(/of 3/)).toBeNull();
  });

  it('says the count alone when the cap is not known yet', () => {
    show();
    expect(screen.getByText('2')).toBeTruthy();
  });

  // With nothing loaded there is no boundary to draw, and a heading over the whole list
  // would say something false about it.
  it('says nothing about groups when none is loaded', () => {
    render(
      <Sidebar
        sessions={[session({ sessionId: 'c', title: 'Cold' })]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      onWiki={() => {}}
        creating={false}
        activity={{}}
      />,
    );

    expect(screen.queryByText('In memory')).toBeNull();
    expect(screen.queryByText('Not loaded')).toBeNull();
  });
});

/** Folding a group away (#124), which is the only way a list of two hundred stays usable. */
describe('folding a group', () => {
  const grouped = [
    session({ sessionId: 'a', title: 'Working', loaded: true }),
    session({ sessionId: 'c', title: 'Cold one' }),
    session({ sessionId: 'd', title: 'Cold two' }),
  ];

  const show = (props: Record<string, unknown> = {}) =>
    render(
      <Sidebar
        sessions={grouped}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      onWiki={() => {}}
        creating={false}
        activity={{}}
        {...props}
      />,
    );

  beforeEach(() => localStorage.clear());

  it('hides the sessions in a group that is folded', async () => {
    show();
    await userEvent.click(screen.getByText('Not loaded'));

    expect(screen.queryByText('Cold one')).toBeNull();
    expect(screen.queryByText('Cold two')).toBeNull();
    // Only that group folds, not the list.
    expect(screen.getByText('Working')).toBeTruthy();
  });

  it('shows them again when it is unfolded', async () => {
    show();
    await userEvent.click(screen.getByText('Not loaded'));
    await userEvent.click(screen.getByText('Not loaded'));

    expect(screen.getByText('Cold one')).toBeTruthy();
  });

  /** Folded, the count is the only thing left saying the sessions are still there. */
  it('says how many are folded away', async () => {
    show();
    await userEvent.click(screen.getByText('Not loaded'));

    expect(screen.getByText('2')).toBeTruthy();
  });

  it('says whether it is open, for a reader who cannot see the caret', async () => {
    show();
    const heading = screen.getByText('Not loaded');
    expect(heading.getAttribute('aria-expanded')).toBe('true');

    await userEvent.click(heading);
    expect(heading.getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * The reason to fold is a long list, which is still long on the next launch. Folding it
   * again every time would be the same work over.
   */
  it('is remembered across a restart', async () => {
    const first = show();
    await userEvent.click(screen.getByText('Not loaded'));
    first.unmount();

    show();
    expect(screen.queryByText('Cold one')).toBeNull();
  });

  /** Losing sight of the open session for the sake of a tidier list is a bad trade. */
  it('keeps showing the selected session even when its group is folded', async () => {
    show({ selectedId: 'c' });
    await userEvent.click(screen.getByText('Not loaded'));

    expect(screen.getByText('Cold one')).toBeTruthy();
    expect(screen.queryByText('Cold two')).toBeNull();
  });
});


/**
 * What a loaded session is doing (#115). The dot said one thing - resident - which is the
 * least interesting answer; what a reader wants to know is which session needs them.
 */
describe('the state a row reports', () => {
  const loaded = [session({ sessionId: 'a', title: 'Working one', loaded: true })];

  const withActivity = (activity: Record<string, { state: 'idle' | 'queued' | 'working' | 'blocked'; queued: number }>) =>
    render(
      <Sidebar
        sessions={loaded}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      onWiki={() => {}}
        creating={false}
        activity={activity}
      />,
    );

  it('says a session is loaded when nothing else is happening', () => {
    const { container } = withActivity({});
    expect(container.querySelector('.activity-idle')).not.toBeNull();
    expect(screen.getByLabelText('Loaded in memory')).toBeTruthy();
  });

  it('says a session is working', () => {
    const { container } = withActivity({ a: { state: 'working', queued: 0 } });
    expect(container.querySelector('.activity-working')).not.toBeNull();
  });

  /** The state that asks for something, so it is named in words and not only coloured. */
  it('says a session is blocked on a decision', () => {
    withActivity({ a: { state: 'blocked', queued: 0 } });
    expect(screen.getByLabelText(/blocked/)).toBeTruthy();
  });

  it('counts what is waiting behind a turn', () => {
    withActivity({ a: { state: 'working', queued: 2 } });
    expect(screen.getByLabelText('Working. 2 messages waiting')).toBeTruthy();
  });

  /** A session on disk costs nothing and is doing nothing, so it carries no mark at all. */
  it('marks nothing on a session that is not loaded', () => {
    const { container } = render(
      <Sidebar
        sessions={[session({ sessionId: 'a', title: 'Cold', loaded: false })]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      onWiki={() => {}}
        creating={false}
        activity={{ a: { state: 'working', queued: 0 } }}
      />,
    );
    expect(container.querySelector('.mark')).toBeNull();
  });
});

/**
 * A session's delegated tasks, under the row that delegated them.
 *
 * Only the ones this app watched start: finding the rest means reading a session's whole
 * log, measured at 2.1 seconds for one 386 MB session against 204 sessions on this machine,
 * and the sidebar is the part of this app that must cost nothing (#178).
 */
describe('Sidebar subagents', () => {
  const watched = (over: Record<string, unknown> = {}) => ({
    agentId: 'a1',
    sessionId: 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8',
    name: 'deep-audit',
    events: [],
    ...over,
  });

  const shown = (props: Record<string, unknown> = {}) =>
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      onWiki={() => {}}
        creating={false}
        activity={{}}
        onSelectSubagent={() => {}}
        {...props}
      />,
    );

  it('shows nothing when none have been watched', () => {
    shown({ subagents: [] });
    expect(screen.queryByTitle(/Open what/)).toBeNull();
  });

  it('names one that is running', () => {
    shown({ subagents: [watched()] });
    expect(screen.getByTitle('Open what deep-audit did')).toBeTruthy();
  });

  it('opens it when clicked', () => {
    const onSelectSubagent = vi.fn();
    shown({ subagents: [watched()], onSelectSubagent });

    fireEvent.click(screen.getByTitle('Open what deep-audit did'));
    expect(onSelectSubagent).toHaveBeenCalledWith('a1');
  });

  it('says when one failed', () => {
    shown({ subagents: [watched({ outcome: 'failed' })] });
    expect(screen.getByText('failed')).toBeTruthy();
  });

  it('says nothing extra when one simply finished', () => {
    shown({ subagents: [watched({ outcome: 'completed' })] });
    expect(screen.queryByText('failed')).toBeNull();
  });

  /** Each belongs to the session that delegated it, not to whichever row is first. */
  it('puts each under its own session', () => {
    const { container } = shown({
      subagents: [watched(), watched({ agentId: 'a2', sessionId: '9ec04ce0-1361-4e11-ae34-9f8747cbac64', name: 'explore' })],
    });

    const lists = container.querySelectorAll('.subagent-list');
    expect(lists).toHaveLength(2);
    expect(lists[0]?.textContent).toContain('deep-audit');
    expect(lists[1]?.textContent).toContain('explore');
  });

  it('marks the one being read', () => {
    const { container } = shown({ subagents: [watched()], selectedSubagentId: 'a1' });
    expect(container.querySelector('.subagent.selected')).toBeTruthy();
  });

  it('lets one be taken off the list', () => {
    const onDismissSubagent = vi.fn();
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      onWiki={() => {}}
        creating={false}
        activity={{}}
        onSelectSubagent={() => {}}
        subagents={[watched()]}
        onDismissSubagent={onDismissSubagent}
      />,
    );

    fireEvent.click(screen.getByLabelText('Take deep-audit off this list'));
    expect(onDismissSubagent).toHaveBeenCalledWith('a1');
  });

  // Without somewhere to open one, a row that cannot be opened is worse than no row.
  it('draws none when there is nothing to open them with', () => {
    shown({ subagents: [watched()], onSelectSubagent: undefined });
    expect(screen.queryByText('deep-audit')).toBeNull();
  });
});


describe('keeping a session among the favourites', () => {
  // Folding is remembered in localStorage, and a group folded by an earlier test in this
  // file would hide rows these need to see.
  beforeEach(() => localStorage.clear());

  const three = [
    session({ sessionId: 'a', title: 'Alpha', loaded: true }),
    session({ sessionId: 'b', title: 'Beta' }),
    session({ sessionId: 'c', title: 'Gamma' }),
  ];

  const shown = (over: Partial<ComponentProps<typeof Sidebar>> = {}) =>
    render(
      <Sidebar
        sessions={three}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        onFavourite={() => {}}
        {...over}
      />,
    );

  /** Rows in the order the sidebar draws them, whichever group each is in. */
  const order = () =>
    [...document.querySelectorAll('.session .session-title')].map((n) => n.textContent?.trim().split(/\s/)[0]);

  it('offers no mark when there is nowhere to keep one', () => {
    shown({ onFavourite: undefined });

    expect(screen.queryByLabelText(/^Favourite /)).toBeNull();
  });

  it('offers one on every row otherwise', () => {
    shown();

    expect(screen.getAllByLabelText(/^Favourite /)).toHaveLength(3);
  });

  it('favourites the session whose mark was pressed', async () => {
    const onFavourite = vi.fn();
    shown({ onFavourite });

    await userEvent.click(screen.getByLabelText('Favourite Beta'));

    expect(onFavourite).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('does not also select the session whose mark was pressed', async () => {
    // The row selects when clicked, and the mark sits inside it: without stopping the click
    // on the way up, marking a session would also open it.
    const onSelect = vi.fn();
    shown({ onFavourite: () => {}, onSelect });

    await userEvent.click(screen.getByLabelText('Favourite Beta'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects from anywhere on the row, not only from the part with the text', async () => {
    const onSelect = vi.fn();
    shown({ onSelect });

    await userEvent.click(screen.getByText('Beta').closest('.session-row') as HTMLElement);

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b', expect.objectContaining({ sessionId: 'b' }));
  });

  it('selects once when the click lands on the text itself', async () => {
    // The text is a button inside the clickable row, so a handler on both would count twice.
    const onSelect = vi.fn();
    shown({ onSelect });

    await userEvent.click(screen.getByText('Beta'));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('offers to unfavourite one that already is', () => {
    shown({ favourites: ['b'] });

    expect(screen.getByLabelText('Unfavourite Beta')).toBeTruthy();
  });

  it('puts a favourited session above everything else', () => {
    shown({ favourites: ['c'] });

    expect(order()[0]).toBe('Gamma');
  });

  it('puts it above a session that is in memory', () => {
    shown({ favourites: ['c'] });

    expect(order()).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('names the group so the ordering does not look arbitrary', () => {
    shown({ favourites: ['c'] });

    expect(screen.getByText('Favourites')).toBeTruthy();
  });

  it('says nothing about favourites when there are none', () => {
    shown();

    expect(screen.queryByText('Favourites')).toBeNull();
  });

  // Listing it twice would double the row and make the count wrong.
  it('draws a favourited session once, not in both groups', () => {
    shown({ favourites: ['a'] });

    expect(order().filter((title) => title === 'Alpha')).toHaveLength(1);
  });

  it('keeps activity order inside the favourites group', () => {
    shown({ favourites: ['a', 'b'] });

    expect(order()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  /**
   * The list always reflects what was asked for. A favourited session that does not match is
   * hidden like any other, or the filter would quietly stop meaning what it says.
   */
  it('hides a favourited session that the filter excludes', async () => {
    shown({ favourites: ['c'] });

    await userEvent.type(screen.getByPlaceholderText(/Filter/), 'Alpha');

    expect(order()).toEqual(['Alpha']);
  });
});




describe('Sidebar session menu', () => {
  const rowFor = (title: string) => screen.getByText(title).closest('.session-row') as HTMLElement;

  it('offers no menu at all when the app supplies no actions', () => {
    render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} />);

    fireEvent.contextMenu(rowFor('Biomes'));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the actions for the session that was right-clicked', () => {
    const actionsFor = vi.fn((s: SessionSummary) => [
      { id: 'favourite', label: `Favourite ${s.title}`, run: () => {} },
    ]);
    render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} actionsFor={actionsFor} />);

    fireEvent.contextMenu(rowFor('Desktop app'));

    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByText('Favourite Desktop app')).toBeTruthy();
  });

  it('takes the right-click off the browser, which would show its own menu over this one', () => {
    render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}}
        actionsFor={() => [{ id: 'favourite', label: 'Favourite', run: () => {} }]} />);

    // fireEvent returns false when the default was prevented.
    expect(fireEvent.contextMenu(rowFor('Biomes'))).toBe(false);
  });

  it('asks again for the session as it is now, not as it was when right-clicked', () => {
    // A session unloads itself on a timer, so what the menu may offer can change between the
    // right-click and the click on a row (#107).
    const actionsFor = (s: SessionSummary) => [
      { id: 'evict', label: s.loaded ? 'Unload from memory' : 'Already unloaded', run: () => {} },
    ];
    const loaded = [session({ sessionId: 'a', title: 'Warm', loaded: true })];
    const view = render(<Sidebar sessions={loaded} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} actionsFor={actionsFor} />);

    fireEvent.contextMenu(rowFor('Warm'));
    expect(screen.getByText('Unload from memory')).toBeTruthy();

    view.rerender(<Sidebar sessions={[session({ sessionId: 'a', title: 'Warm', loaded: false })]}
        selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} actionsFor={actionsFor} />);

    expect(screen.getByText('Already unloaded')).toBeTruthy();
  });

  it('closes the menu when the session it was opened on leaves the list', () => {
    const actionsFor = () => [{ id: 'favourite', label: 'Favourite', run: () => {} }];
    const one = [session({ sessionId: 'a', title: 'Warm' })];
    const view = render(<Sidebar sessions={one} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} actionsFor={actionsFor} />);

    fireEvent.contextMenu(rowFor('Warm'));
    expect(screen.getByRole('menu')).toBeTruthy();

    view.rerender(<Sidebar sessions={[]} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} actionsFor={actionsFor} />);

    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('folding the sidebar away from its own header', () => {
  it('offers the control when the app supplies one', async () => {
    const onToggle = vi.fn();
    render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} onToggle={onToggle} />);

    await userEvent.click(screen.getByLabelText('Hide the sidebar'));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('leaves the header as it was when the app supplies none', () => {
    render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} />);

    expect(screen.queryByLabelText('Hide the sidebar')).toBeNull();
  });

  it('puts it before the controls that do something to a session', () => {
    render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} onToggle={() => {}} />);

    const header = screen.getByLabelText('Hide the sidebar').closest('header') as HTMLElement;
    const inHeader = [...header.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'));

    expect(inHeader).toEqual(['Hide the sidebar', 'Wiki', 'New']);
  });
});

/**
 * A session stopped on a question is the one case where the list stops being only what was
 * asked for: the agent is stopped until it is answered and a permission request expires
 * after five minutes, so hiding it costs a turn rather than a scroll (#187).
 */
describe('a session waiting for an answer', () => {
  const three = [
    session({ sessionId: 'a', title: 'Alpha' }),
    session({ sessionId: 'b', title: 'Beta' }),
    session({ sessionId: 'c', title: 'Gamma' }),
  ];
  const blocked = (...ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { state: 'blocked' as const, queued: 0 }]));

  const shown = (over: Partial<ComponentProps<typeof Sidebar>> = {}) =>
    render(
      <Sidebar
        sessions={three}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        {...over}
      />,
    );

  it('says nothing at the top when nothing is waiting', () => {
    shown();

    expect(screen.queryByText(/waiting/)).toBeNull();
    expect(screen.queryByText('Waiting for you')).toBeNull();
  });

  it('counts them where someone not looking at the list will see it', () => {
    shown({ activity: blocked('b', 'c') });

    expect(screen.getByText(/2 waiting/)).toBeTruthy();
  });

  it('puts them above everything, including what was favourited', () => {
    shown({ activity: blocked('c'), favourites: ['a'], onFavourite: () => {} });

    const headings = screen.getAllByText(/Waiting for you|Favourites|Not loaded/).map((n) => n.textContent);
    expect(headings[0]).toBe('Waiting for you');
  });

  it('keeps one out of the group it would otherwise be in', () => {
    // Drawn once, like a favourite that is also loaded.
    shown({ activity: blocked('a'), favourites: ['a'], onFavourite: () => {} });

    expect(screen.getAllByText('Alpha')).toHaveLength(1);
  });

  it('shows one the filter would have hidden', async () => {
    shown({ activity: blocked('c') });

    await userEvent.type(screen.getByRole('searchbox'), 'Alpha');

    // Beta proves the filter actually ran: without this the test passes whether or not it did.
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Gamma')).toBeTruthy();
  });

  it('goes to one when the count is pressed', async () => {
    const onSelect = vi.fn();
    shown({ activity: blocked('b'), onSelect });

    await userEvent.click(screen.getByText(/1 waiting/));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b', expect.objectContaining({ sessionId: 'b' }));
  });

  it('walks them rather than returning to the same one', async () => {
    const onSelect = vi.fn();
    shown({ activity: blocked('a', 'c'), selectedId: 'a', onSelect });

    await userEvent.click(screen.getByText(/2 waiting/));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('c', expect.objectContaining({ sessionId: 'c' }));
  });

  it('comes back round to the first from the last', async () => {
    const onSelect = vi.fn();
    shown({ activity: blocked('a', 'c'), selectedId: 'c', onSelect });

    await userEvent.click(screen.getByText(/2 waiting/));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a', expect.objectContaining({ sessionId: 'a' }));
  });
});

/**
 * Archiving folds a group away rather than hiding anything. #101 warns that three
 * overlapping reasons a session might not appear is one more than can be reasoned about, so
 * an archived session is always there to be counted and one press from being read.
 */
describe('a session put away', () => {
  // Folding is remembered across restarts, so it is also remembered across tests: without
  // this, a test that unfolds the group leaves the next one starting from open.
  beforeEach(() => localStorage.clear());

  const three = [
    session({ sessionId: 'a', title: 'Alpha' }),
    session({ sessionId: 'b', title: 'Beta' }),
    session({ sessionId: 'c', title: 'Gamma' }),
  ];

  const shown = (over: Partial<ComponentProps<typeof Sidebar>> = {}) =>
    render(
      <Sidebar
        sessions={three}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        {...over}
      />,
    );

  it('says nothing about an archive that is empty', () => {
    shown();

    expect(screen.queryByText('Archived')).toBeNull();
  });

  it('comes out of the list it was in', () => {
    shown({ archived: ['b'] });

    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('is folded away rather than hidden, and says how many', async () => {
    shown({ archived: ['b', 'c'] });

    const group = screen.getByText('Archived').closest('button') as HTMLElement;
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(group.textContent).toContain('2');
  });

  it('is one press from being read', async () => {
    shown({ archived: ['b'] });

    await userEvent.click(screen.getByText('Archived'));

    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('is last, under everything still in use', () => {
    shown({ archived: ['c'], favourites: ['a'], onFavourite: () => {} });

    // A folded group carries its count, so match the name rather than the whole label.
    const headings = screen.getAllByText(/Favourites|Not loaded|Archived/).map((n) => n.textContent ?? '');
    expect(headings[headings.length - 1]).toMatch(/^Archived/);
    expect(headings[0]).toBe('Favourites');
  });

  it('still shows the one being read, folded or not', () => {
    // A folded group holding the open session shows it, or the reader loses where they are.
    shown({ archived: ['b'], selectedId: 'b' });

    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('is found by a search, since being findable is the reason to keep it', async () => {
    shown({ archived: ['c'] });

    await userEvent.type(screen.getByRole('searchbox'), 'Gamma');
    await userEvent.click(screen.getByText('Archived'));

    expect(screen.getByText('Gamma')).toBeTruthy();
  });

  it('comes back out when it is no longer waiting to be dealt with', () => {
    // Being stopped on a question outranks having been finished with.
    shown({ archived: ['b'], activity: { b: { state: 'blocked', queued: 0 } } });

    expect(screen.getByText('Waiting for you')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.queryByText('Archived')).toBeNull();
  });
});

describe('tags in the sidebar', () => {
  const three = [
    session({ sessionId: 'a', title: 'Alpha' }),
    session({ sessionId: 'b', title: 'Beta' }),
    session({ sessionId: 'c', title: 'Gamma' }),
  ];

  const shown = (over: Partial<ComponentProps<typeof Sidebar>> = {}) =>
    render(
      <Sidebar
        sessions={three}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        {...over}
      />,
    );

  it('draws what is true about a session on its row', () => {
    shown({ tags: { b: ['bug', 'spike'] } });

    const row = screen.getByText('Beta').closest('.session') as HTMLElement;
    expect([...row.querySelectorAll('.tag')].map((t) => t.textContent)).toEqual(['bug', 'spike']);
  });

  it('draws none for a session with none', () => {
    shown({ tags: { b: ['bug'] } });

    const row = screen.getByText('Alpha').closest('.session') as HTMLElement;
    expect(row.querySelector('.tag')).toBeNull();
  });

  it('filters down to one tag', async () => {
    shown({ tags: { a: ['bug'], b: ['spike'] } });

    await userEvent.type(screen.getByRole('searchbox'), 'tag:bug');

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.queryByText('Gamma')).toBeNull();
  });

  it('narrows rather than widens when a tag is added to a search', async () => {
    shown({ tags: { a: ['bug'], b: ['bug'] } });

    await userEvent.type(screen.getByRole('searchbox'), 'tag:bug Alpha');

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('finds a tag typed without the prefix', async () => {
    shown({ tags: { c: ['spike'] } });

    await userEvent.type(screen.getByRole('searchbox'), 'spike');

    expect(screen.getByText('Gamma')).toBeTruthy();
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('says nothing matched when no session carries the tag', async () => {
    shown({ tags: { a: ['bug'] } });

    await userEvent.type(screen.getByRole('searchbox'), 'tag:nonexistent');

    expect(screen.getByText('No sessions match that filter.')).toBeTruthy();
  });
});