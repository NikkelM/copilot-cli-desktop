// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import { Sidebar } from './Sidebar';
import type { SessionSummary } from '../../shared/protocol';

const findSessions = vi.hoisted(() => vi.fn());
const searchSessions = vi.hoisted(() => vi.fn());
vi.mock('../lib/sidecar', () => ({
  findSessions: (prefix: string) => findSessions(prefix),
  searchSessions: (query: string) => searchSessions(query),
}));

beforeEach(() => {
  findSessions.mockReset().mockResolvedValue({ sessions: [] });
  searchSessions.mockReset().mockResolvedValue([]);
});

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

/** The session rows in the order they are drawn, by first word of each title. */
const order = () =>
  [...document.querySelectorAll('.session .session-title')].map((n) => n.textContent?.trim().split(/\s/)[0]);

/** The group headings in order, without the count that follows each label. */
const groupNames = () =>
  [...document.querySelectorAll('button.group')].map((heading) =>
    [...heading.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('')
      .trim(),
  );

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
/**
 * A title is not always a title. A session this app starts keeps its whole first prompt as
 * its name until something shortens it, and nothing does: every session made through the
 * SDK on this machine still has `summary_count: 0`. One of them is 303 characters, which
 * filled thirteen lines of the sidebar (#197).
 */
describe('a title too long to be one', () => {
  const long = 'To my global copilot instructions add this type of guidance: all external facing text should go through the relevant writer persona and avoid the usual markers. Do we have a good enough personality file to cover these?';

  const shown = (title: string | null) =>
    render(
      <Sidebar
        sessions={[session({ sessionId: 'a', title })]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
      />,
    );

  const drawn = () => document.querySelector('.session-title')!;

  it('cuts one that would crowd out the list', () => {
    shown(long);

    const text = drawn().textContent!;
    expect(text.length).toBeLessThan(long.length);
    expect(text.endsWith('…')).toBe(true);
  });

  it('keeps the whole of it within reach', () => {
    shown(long);

    expect(drawn().getAttribute('title')).toBe(long);
  });

  // The names that are actually names must come through untouched, or this has cost more
  // than it saved: the longest the runtime generates on this machine is 44 characters.
  it.each([
    ['Investigate Arcana Navigation Bug', 33],
    ['Export Active Sessions Excluding Current', 40],
    ['A name as long as the longest one seen here.x', 44],
  ])('leaves %s alone', (title) => {
    shown(title);

    expect(drawn().textContent).toBe(title);
    expect(drawn().getAttribute('title')).toBe(title);
  });

  it('draws a prompt that spans lines as one line', () => {
    shown('A question\n\nwith a blank line in it');

    expect(drawn().textContent).toBe('A question with a blank line in it');
  });

  it('still says when a session has no title at all', () => {
    shown(null);

    expect(drawn().textContent).toBe('Untitled session');
    expect(drawn().getAttribute('title')).toBeNull();
  });
});

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

  /** A group of one is a group, and "1 sessions" reads as a bug in the thing that wrote it. */
  it('counts one session as one session', async () => {
    show();
    const loaded = screen.getByText('In memory').closest('button')!;

    await userEvent.click(loaded);

    expect(loaded.getAttribute('title')).toBe('Show the 1 session in this group');
  });

  it('counts several as several', async () => {
    show();
    const cold = screen.getByText('Not loaded').closest('button')!;

    await userEvent.click(cold);

    expect(cold.getAttribute('title')).toBe('Show the 2 sessions in this group');
  });

  /** Folded, the count is the only thing left saying the sessions are still there. */
  it('says how many are folded away', async () => {
    show();
    await userEvent.click(screen.getByText('Not loaded'));

    expect(screen.getByText('2')).toBeTruthy();
  });

  /**
   * And open too. A count that appears only on folding reads as the number having changed,
   * and it is the fastest answer to how much is in a group either way.
   */
  it('says how many are in it while it is open', () => {
    show();

    const heading = screen.getByText('Not loaded');
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    expect(heading.querySelector('.group-count')?.textContent).toBe('2');
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

  /**
   * Subagents delegate in turn, so the list is a tree (#178). Drawn by the same rows at
   * every level, which is what lets it go as deep as the work did.
   */
  describe('one delegated by another', () => {
    const family = [
      watched({ agentId: 'outer', name: 'outer-agent' }),
      watched({ agentId: 'inner', name: 'inner-agent', parentAgentId: 'outer' }),
    ];

    it('draws it inside the task that delegated it', () => {
      const { container } = shown({ subagents: family });

      const rows = [...container.querySelectorAll('.subagent-item')];
      const outer = rows.find((li) => li.querySelector('.subagent-name')?.textContent === 'outer-agent');

      // Scoped, or the ancestor part of the selector matches the list this row sits in.
      expect(outer?.querySelector(':scope > .subagent-list .subagent-name')?.textContent).toBe('inner-agent');
    });

    it('draws the one the session delegated outside it', () => {
      const { container } = shown({ subagents: family });

      const inner = [...container.querySelectorAll('.subagent-item')].find(
        (li) => li.querySelector('.subagent-name')?.textContent === 'inner-agent',
      );

      expect(inner?.querySelector('.subagent-name')?.textContent).toBe('inner-agent');
      expect(inner?.querySelectorAll('.subagent-list')).toHaveLength(0);
    });

    /** A parent that aged out or was never watched leaves its task with nowhere to sit. */
    it('draws one whose parent is not on the list rather than hiding it', () => {
      shown({ subagents: [watched({ agentId: 'orphan', name: 'lost-agent', parentAgentId: 'gone' })] });

      expect(screen.getByText('lost-agent')).toBeTruthy();
    });

    it('goes as deep as the work did', () => {
      shown({
        subagents: [
          watched({ agentId: 'a', name: 'first' }),
          watched({ agentId: 'b', name: 'second', parentAgentId: 'a' }),
          watched({ agentId: 'c', name: 'third', parentAgentId: 'b' }),
        ],
      });

      expect(screen.getByText('third')).toBeTruthy();
    });
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

    fireEvent.click(screen.getByLabelText('Hide deep-audit'));
    expect(onDismissSubagent).toHaveBeenCalledWith('a1');
  });

  // Without somewhere to open one, a row that cannot be opened is worse than no row.
  it('draws none when there is nothing to open them with', () => {
    shown({ subagents: [watched()], onSelectSubagent: undefined });
    expect(screen.queryByText('deep-audit')).toBeNull();
  });

  /**
   * Keeping a task stops it ageing out (#180). Only offered once the log holds its work,
   * since a kept row that opens onto nothing would be worse than no row.
   */
  describe('keeping one', () => {
    const keepable = () => true;

    it('offers nothing while this app is the only copy of the work', () => {
      shown({ subagents: [watched()], onKeepSubagent: () => {}, keepableSubagent: () => false });
      expect(screen.queryByRole('button', { name: /^Keep / })).toBeNull();
    });

    it('offers to keep one the log holds', () => {
      shown({ subagents: [watched()], onKeepSubagent: () => {}, keepableSubagent: keepable });
      expect(screen.getByRole('button', { name: 'Keep deep-audit' })).toBeTruthy();
    });

    it('asks for it to be kept', async () => {
      const onKeepSubagent = vi.fn();
      shown({ subagents: [watched()], onKeepSubagent, keepableSubagent: keepable });

      await userEvent.click(screen.getByRole('button', { name: 'Keep deep-audit' }));

      expect(onKeepSubagent).toHaveBeenCalledWith('a1');
    });

    /** A kept row says so, and offers the way back out rather than the way in again. */
    it('says when one is kept', () => {
      shown({
        subagents: [watched()],
        onKeepSubagent: () => {},
        keepableSubagent: keepable,
        isKeptSubagent: () => true,
      });

      const button = screen.getByRole('button', { name: 'Stop keeping deep-audit' });
      expect(button.getAttribute('aria-pressed')).toBe('true');
    });
  });

  /**
   * Right-clicking a delegated task showed the webview's own menu - Back, Refresh, Print -
   * because only session rows had one of their own (#225).
   */
  describe('its menu', () => {
    const actions = [{ id: 'keep', label: 'Keep', run: () => {} }];

    it('offers the actions belonging to the task', () => {
      shown({ subagents: [watched()], subagentActionsFor: () => actions });

      fireEvent.contextMenu(screen.getByText('deep-audit'));

      expect(screen.getByText('Keep')).toBeTruthy();
    });

    it('is offered for the task that was right-clicked', () => {
      const subagentActionsFor = vi.fn(() => actions);
      shown({ subagents: [watched()], subagentActionsFor });

      fireEvent.contextMenu(screen.getByText('deep-audit'));

      expect(subagentActionsFor).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }));
    });

    /** The entry that goes to the delegating turn needs the moment the task began. */
    it('hands over what the task knows about itself', () => {
      const subagentActionsFor = vi.fn(() => actions);
      shown({
        subagents: [watched({ startedAt: '2026-09-30T10:00:00.000Z' })],
        subagentActionsFor,
      });

      fireEvent.contextMenu(screen.getByText('deep-audit'));

      expect(subagentActionsFor).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8',
          startedAt: '2026-09-30T10:00:00.000Z',
        }),
      );
    });

    /** The webview would otherwise draw its own, which is the whole point of having one. */
    it('takes the right-click for itself', () => {
      shown({ subagents: [watched()], subagentActionsFor: () => actions });

      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      screen.getByText('deep-audit').dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    });

    // The task's row sits inside the session's, and they are two different things to act on.
    it('does not open the session menu underneath it', () => {
      const actionsFor = vi.fn(() => []);
      shown({ subagents: [watched()], subagentActionsFor: () => actions, actionsFor });

      fireEvent.contextMenu(screen.getByText('deep-audit'));

      expect(actionsFor).not.toHaveBeenCalled();
    });

    it('draws nothing when there are no actions to offer', () => {
      shown({ subagents: [watched()], subagentActionsFor: undefined });

      fireEvent.contextMenu(screen.getByText('deep-audit'));

      expect(screen.queryByText('Keep')).toBeNull();
    });
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

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b', expect.objectContaining({ sessionId: 'b' }), undefined, '');
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

  it('puts a favourite above the sessions nobody marked', () => {
    shown({ favourites: ['c'] });

    expect(order()).toEqual(['Alpha', 'Gamma', 'Beta']);
  });

  // The group says what a session costs, not what was once decided about it.
  it('leaves a loaded session above it, since what is resident comes first', () => {
    shown({ favourites: ['c'] });

    expect(order()[0]).toBe('Alpha');
  });

  it('shows a favourite that is loaded among what is in memory, not under Favourites', () => {
    shown({ favourites: ['a'] });

    expect(order()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(screen.queryByText('Favourites')).toBeNull();
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

describe('the app own controls in the sidebar header', () => {
  const sessions = [session({ sessionId: 'a', title: 'Alpha' })];

  const shown = (over: Partial<ComponentProps<typeof Sidebar>> = {}) =>
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        onToggle={() => {}}
        {...over}
      />,
    );

  const named = () =>
    [...(document.querySelector('.sidebar-header') as HTMLElement).querySelectorAll('button')].map(
      (button) => button.textContent || button.getAttribute('aria-label'),
    );

  it('puts settings on the left, and the wiki and new on the right', () => {
    shown({ onSettings: () => {} });

    expect(named()).toEqual(['Hide the sidebar', 'Settings', 'Wiki', 'New']);
  });

  /**
   * The order alone does not say which side each is on, since both sides read left to
   * right. What separates them is the group, which is what carries the auto margin.
   */
  it('keeps settings out of the group that is pushed right', () => {
    shown({ onSettings: () => {} });

    const group = document.querySelector('.sidebar-actions') as HTMLElement;
    const inGroup = [...group.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'));

    expect(inGroup).toEqual(['Wiki', 'New']);
    expect(group.contains(screen.getByLabelText('Settings'))).toBe(false);
  });

  it('opens the settings window when it is pressed', async () => {
    const onSettings = vi.fn();
    shown({ onSettings });

    await userEvent.click(screen.getByLabelText('Settings'));

    expect(onSettings).toHaveBeenCalledOnce();
  });

  it('leaves the control out when there is nothing to open', () => {
    shown();

    expect(screen.queryByLabelText('Settings')).toBeNull();
    expect(named()).toEqual(['Hide the sidebar', 'Wiki', 'New']);
  });
});

/**
 * A session stopped on a question is not lifted out of the list: it sits where its loadedness
 * puts it, which is among what is in memory, since an agent stopped on a question is resident
 * by definition. What makes it actionable is the count above the list, which is visible
 * whatever the list is showing and jumps straight to one (#187).
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

  it('leaves it where it sits rather than lifting it to the top', () => {
    const loaded = [
      session({ sessionId: 'a', title: 'Alpha', loaded: true }),
      session({ sessionId: 'b', title: 'Beta' }),
      session({ sessionId: 'c', title: 'Gamma' }),
    ];
    shown({ sessions: loaded, activity: blocked('c'), favourites: ['c'], onFavourite: () => {} });

    // Gamma is waiting, but it is cold and favourited, so that is where it is drawn.
    expect(groupNames()).toEqual(['In memory', 'Favourites', 'Not loaded']);
    expect(order()).toEqual(['Alpha', 'Gamma', 'Beta']);
  });

  it('draws no group of its own', () => {
    shown({ activity: blocked('a', 'b', 'c') });

    expect(screen.queryByText('Waiting for you')).toBeNull();
  });

  it('is hidden by a filter like anything else, and still reachable from the count', async () => {
    const onSelect = vi.fn();
    shown({ activity: blocked('c'), onSelect });

    await userEvent.type(screen.getByRole('searchbox'), 'Alpha');

    // Beta proves the filter actually ran: without this the test passes whether or not it did.
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.queryByText('Gamma')).toBeNull();
    expect(screen.getByText('Alpha')).toBeTruthy();

    // The count is what keeps it one press away rather than the list.
    await userEvent.click(screen.getByText(/1 waiting/));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('c', expect.objectContaining({ sessionId: 'c' }));
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

    expect(groupNames()).toEqual(['Favourites', 'Not loaded', 'Archived']);
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

  it('comes back out once it is loaded, since using it says it is not finished with', () => {
    const loaded = [
      session({ sessionId: 'a', title: 'Alpha' }),
      session({ sessionId: 'b', title: 'Beta', loaded: true }),
      session({ sessionId: 'c', title: 'Gamma' }),
    ];
    shown({ sessions: loaded, archived: ['b'] });

    expect(screen.getByText('In memory')).toBeTruthy();
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

    const row = screen.getByText('Beta').closest('.session-row') as HTMLElement;
    expect([...row.querySelectorAll('.tag')].map((t) => t.textContent)).toEqual(['bug', 'spike']);
  });

  it('draws none for a session with none', () => {
    shown({ tags: { b: ['bug'] } });

    const row = screen.getByText('Alpha').closest('.session-row') as HTMLElement;
    expect(row.querySelector('.tag')).toBeNull();
  });

  it('narrows to the rest like it when one is pressed', async () => {
    const onSelect = vi.fn();
    shown({ tags: { a: ['bug'], b: ['bug'], c: ['spike'] }, onSelect });

    const row = screen.getByText('Alpha').closest('.session-row') as HTMLElement;
    await userEvent.click(row.querySelector('.tag') as HTMLElement);

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.queryByText('Gamma')).toBeNull();
  });

  it('does not open the session it was pressed on', async () => {
    // The row opens the session; the chip asks about every session like it.
    const onSelect = vi.fn();
    shown({ tags: { a: ['bug'] }, onSelect });

    const row = screen.getByText('Alpha').closest('.session-row') as HTMLElement;
    await userEvent.click(row.querySelector('.tag') as HTMLElement);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('presses again to stop filtering', async () => {
    shown({ tags: { a: ['bug'] } });
    const chip = () => (screen.getByText('Alpha').closest('.session-row') as HTMLElement).querySelector('.tag') as HTMLElement;

    await userEvent.click(chip());
    expect(screen.queryByText('Beta')).toBeNull();

    await userEvent.click(chip());
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('is the same choice the tag menu makes', async () => {
    shown({ tags: { a: ['bug'], b: ['bug'] } });
    const row = screen.getByText('Alpha').closest('.session-row') as HTMLElement;

    await userEvent.click(row.querySelector('.tag') as HTMLElement);
    await userEvent.click(screen.getByLabelText(/Filtering by/));

    expect(within(screen.getByRole('group')).getByText('bug').getAttribute('aria-pressed')).toBe('true');
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

describe('filtering by tags chosen from the menu', () => {
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

  const openMenu = () => userEvent.click(screen.getByLabelText(/Filter by tag|Filtering by/));
  /** Scoped to the menu: the same tag is drawn on the rows carrying it as well. */
  const inMenu = (name: string) => within(screen.getByRole('group')).getByText(name);

  it('offers nothing to filter by until something is tagged', () => {
    shown();

    expect(screen.queryByLabelText('Filter by tag')).toBeNull();
  });

  it('narrows to the sessions carrying a chosen tag', async () => {
    shown({ tags: { a: ['bug'], b: ['spike'] } });

    await openMenu();
    await userEvent.click(inMenu('bug'));

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.queryByText('Gamma')).toBeNull();
  });

  it('wants every chosen tag, not any of them', async () => {
    shown({ tags: { a: ['bug', 'spike'], b: ['bug'] } });

    await openMenu();
    await userEvent.click(inMenu('bug'));
    await userEvent.click(inMenu('spike'));

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('narrows alongside what was typed rather than replacing it', async () => {
    shown({ tags: { a: ['bug'], b: ['bug'] } });

    await openMenu();
    await userEvent.click(inMenu('bug'));
    await userEvent.type(screen.getByRole('searchbox'), 'Alpha');

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('counts the same tag once when it is both typed and chosen', async () => {
    shown({ tags: { a: ['bug'] } });

    await openMenu();
    await userEvent.click(inMenu('bug'));
    await userEvent.type(screen.getByRole('searchbox'), 'tag:bug');

    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('says what each tag would leave, once something is chosen', async () => {
    shown({ tags: { a: ['bug', 'spike'], b: ['bug'], c: ['spike'] } });
    await openMenu();

    // Three tags, counted across every session: bug on two, spike on two.
    expect([...screen.getByRole('group').querySelectorAll('.tag')].map((b) => b.textContent)).toEqual([
      'bug2',
      'spike2',
    ]);

    await userEvent.click(inMenu('bug'));

    // With bug chosen only a and b remain, and spike is on one of them.
    expect([...screen.getByRole('group').querySelectorAll('.tag')].map((b) => b.textContent)).toEqual([
      'bug2',
      'spike1',
    ]);
  });

  it('stops offering a tag that would leave nothing', async () => {
    shown({ tags: { a: ['bug'], b: ['spike'] } });
    await openMenu();
    expect(within(screen.getByRole('group')).queryByText('spike')).toBeTruthy();

    await userEvent.click(inMenu('bug'));

    // No session carries both, so choosing spike could only empty the list.
    expect(within(screen.getByRole('group')).queryByText('spike')).toBeNull();
    expect(within(screen.getByRole('group')).queryByText('bug')).toBeTruthy();
  });

  it('gives the whole list back when the choice is cleared', async () => {
    shown({ tags: { a: ['bug'] } });
    await openMenu();
    await userEvent.click(inMenu('bug'));
    expect(screen.queryByText('Beta')).toBeNull();

    await userEvent.click(inMenu('Clear'));

    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('lets go of a tag that no session carries any more', async () => {
    // Otherwise the list empties with nothing on screen saying why.
    const view = shown({ tags: { a: ['bug'] } });
    await openMenu();
    await userEvent.click(inMenu('bug'));
    expect(screen.queryByText('Beta')).toBeNull();

    view.rerender(
      <Sidebar
        sessions={three}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        tags={{}}
      />,
    );

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
  });
});

describe('a session on its way into memory', () => {
  const two = [session({ sessionId: 'a', title: 'Alpha' }), session({ sessionId: 'b', title: 'Beta' })];

  const shown = (over: Partial<ComponentProps<typeof Sidebar>> = {}) =>
    render(
      <Sidebar
        sessions={two}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        {...over}
      />,
    );

  const markOn = (title: string) =>
    (screen.getByText(title).closest('.session') as HTMLElement).querySelector('.activity');

  it('is marked even though it is not loaded yet', () => {
    // The mark is otherwise only drawn for a loaded session, and this one is not - which is
    // the whole reason the state exists.
    shown({ activity: { a: { state: 'loading', queued: 0 } } });

    expect(markOn('Alpha')?.className).toContain('activity-loading');
  });

  it('says what it is doing, for a reader who cannot see the colour', () => {
    shown({ activity: { a: { state: 'loading', queued: 0 } } });

    expect(markOn('Alpha')?.getAttribute('aria-label')).toBe('Coming into memory');
  });

  it('leaves a session nobody is waking unmarked', () => {
    shown({ activity: { a: { state: 'loading', queued: 0 } } });

    expect(markOn('Beta')).toBeNull();
  });

  it('gives the mark back to the loaded state once it arrives', () => {
    const loaded = [session({ sessionId: 'a', title: 'Alpha', loaded: true })];
    render(
      <Sidebar
        sessions={loaded}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{ a: { state: 'idle', queued: 0 } }}
      />,
    );

    expect(markOn('Alpha')?.className).toContain('activity-idle');
  });
});

/**
 * The box looks inside the conversations as well as at the labels (#30). What a session was
 * called is still the stronger signal, so those come first and the rest explain themselves.
 */
describe('filtering by what a session said', () => {
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

  const type = async (text: string) => {
    await userEvent.type(screen.getByPlaceholderText(/Filter by title/), text);
    // The ask is debounced, and the reply lands a tick after that.
    await vi.waitFor(() => expect(searchSessions).toHaveBeenCalled());
  };

  const said = (sessionId: string, excerpt = 'we discussed \u0002eviction\u0003 here') => ({
    sessionId,
    excerpt,
    source: `${sessionId}:turn:4`,
  });

  const titles = () => [...document.querySelectorAll('.session-title')].map((n) => n.textContent);

  it('finds a session by something it said rather than by its name', async () => {
    searchSessions.mockResolvedValue([said('c')]);
    shown();

    await type('eviction');

    await vi.waitFor(() => expect(screen.getByText('Gamma')).toBeTruthy());
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('says why a session nobody named is in the list', async () => {
    searchSessions.mockResolvedValue([said('c')]);
    shown();

    await type('eviction');

    await vi.waitFor(() => expect(document.querySelector('.session-excerpt')).toBeTruthy());
    expect(document.querySelector('.session-excerpt mark')?.textContent).toBe('eviction');
  });

  it('puts the ones named after it above the ones that merely said it', async () => {
    // Gamma is above Alpha in the list, so only the ranking can put Alpha first.
    searchSessions.mockResolvedValue([said('c'), said('a')]);
    shown({
      sessions: [session({ sessionId: 'c', title: 'Gamma' }), session({ sessionId: 'a', title: 'Alpha' })],
    });

    await type('alpha');

    await vi.waitFor(() => expect(titles().length).toBe(2));
    expect(titles()).toEqual(['Alpha', 'Gamma']);
  });

  // Its name already explains it; an excerpt under every row would be a wall of prose.
  it('explains nothing under a row the name found', async () => {
    searchSessions.mockResolvedValue([said('a')]);
    shown();

    await type('alpha');

    await vi.waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(document.querySelector('.session-excerpt')).toBeNull();
  });

  it('still wants every chosen tag, even from a session that said it', async () => {
    searchSessions.mockResolvedValue([said('c')]);
    shown({ tags: { a: ['bug'], c: ['spike'] } });

    await userEvent.type(screen.getByPlaceholderText(/Filter by title/), 'tag:bug eviction');
    await vi.waitFor(() => expect(searchSessions).toHaveBeenCalled());

    expect(screen.queryByText('Gamma')).toBeNull();
  });

  // A tag term narrows what is here; it has nothing to look for in a transcript.
  it('asks nothing of the transcripts for a query of only tags', async () => {
    shown({ tags: { a: ['bug'] } });

    await userEvent.type(screen.getByPlaceholderText(/Filter by title/), 'tag:bug');

    await new Promise((r) => setTimeout(r, 300));
    expect(searchSessions).not.toHaveBeenCalled();
  });
});


describe('opening a search result where it was said', () => {
  const three = [
    session({ sessionId: 'a', title: 'Alpha' }),
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

  const find = async (text: string) => {
    await userEvent.type(screen.getByPlaceholderText(/Filter by title/), text);
    await vi.waitFor(() => expect(searchSessions).toHaveBeenCalled());
  };

  it('sends the match, so the transcript can open where it was said', async () => {
    searchSessions.mockResolvedValue([{ sessionId: 'c', excerpt: 'said \u0002it\u0003', source: 'c:turn:42' }]);
    const onSelect = vi.fn();
    shown({ onSelect });

    await find('eviction');
    await vi.waitFor(() => expect(screen.getByText('Gamma')).toBeTruthy());
    await userEvent.click(screen.getByText('Gamma').closest('.session-row') as HTMLElement);

    expect(onSelect).toHaveBeenCalledWith('c', expect.objectContaining({ sessionId: 'c' }), expect.objectContaining({ source: 'c:turn:42' }), 'eviction');
  });

  // The name found it, so the reader meant the session rather than a moment inside it.
  it('sends no match for a session the name found', async () => {
    searchSessions.mockResolvedValue([{ sessionId: 'a', excerpt: 'said \u0002it\u0003', source: 'a:turn:42' }]);
    const onSelect = vi.fn();
    shown({ onSelect });

    await find('alpha');
    await userEvent.click(screen.getByText('Alpha').closest('.session-row') as HTMLElement);

    expect(onSelect).toHaveBeenCalledWith('a', expect.objectContaining({ sessionId: 'a' }), undefined, 'alpha');
  });

  // A match in a checkpoint is not in the conversation, so there is no turn to go to.
  it('sends no turn for a match that is not in a turn', async () => {
    searchSessions.mockResolvedValue([{ sessionId: 'c', excerpt: 'said \u0002it\u0003', source: 'c:ckpt:0:checkpoint_history' }]);
    const onSelect = vi.fn();
    shown({ onSelect });

    await find('eviction');
    await vi.waitFor(() => expect(screen.getByText('Gamma')).toBeTruthy());
    await userEvent.click(screen.getByText('Gamma').closest('.session-row') as HTMLElement);

    expect(onSelect).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ sessionId: 'c' }),
      expect.objectContaining({ source: 'c:ckpt:0:checkpoint_history' }),
      'eviction',
    );
  });
});

/** A row shows its title and repository; anything else it matched on needs saying. */
describe('saying why a row is in the list', () => {
  const shown = (over: Partial<ComponentProps<typeof Sidebar>> = {}) =>
    render(
      <Sidebar
        sessions={[session({ sessionId: 'a', title: 'Design Nyx NPC Traits', branch: 'feature/npc-assist-traits' })]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        {...over}
      />,
    );

  it('names the branch a row was found by, which the row does not show', async () => {
    shown();

    await userEvent.type(screen.getByPlaceholderText(/Filter by title/), 'assist');

    await vi.waitFor(() => expect(document.querySelector('.session-excerpt')).toBeTruthy());
    expect(document.querySelector('.session-excerpt')?.textContent).toContain('feature/npc-assist-traits');
    expect(document.querySelector('.session-excerpt mark')?.textContent).toBe('assist');
  });

  it('says nothing when the title is the reason, which is already on the row', async () => {
    shown({ sessions: [session({ sessionId: 'a', title: 'Assist with the form' })] });

    await userEvent.type(screen.getByPlaceholderText(/Filter by title/), 'assist');

    await new Promise((r) => setTimeout(r, 60));
    expect(document.querySelector('.session-excerpt')).toBeNull();
  });
});
