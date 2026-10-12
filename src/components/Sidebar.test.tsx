// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import { Sidebar } from './Sidebar';
import type { SessionAction } from './SessionMenu';
import { useMarked } from '../lib/useMarked';
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
    // And says nothing further about it. A label the browser pops up to repeat what is
    // already written is one nobody needs, and it appeared under a pointer that had not
    // moved while the keyboard was somewhere else entirely.
    expect(drawn().getAttribute('title')).toBeNull();
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

/**
 * A session being resumed groups with the resident ones.
 *
 * It left the reader pressing Load and watching nothing move: the row stayed under Not
 * loaded for the seconds a resume takes, which says the opposite of what is happening. A
 * session is already costing memory while it arrives.
 */
describe('a session on its way into memory', () => {
  const mixed = [
    session({ sessionId: 'a', title: 'Resident', loaded: true }),
    session({ sessionId: 'b', title: 'Arriving' }),
    session({ sessionId: 'c', title: 'Cold' }),
  ];

  const show = (loading?: ReadonlySet<string>) =>
    render(
      <Sidebar
        sessions={mixed}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        loading={loading}
      />,
    );

  /** Rows in a group, by the heading above them. */
  const under = (label: string) => {
    const heading = screen.getByText(label).closest('li')!;
    return [...heading.querySelectorAll('.session-title')].map((n) => n.textContent?.trim());
  };

  it('draws it with the resident ones rather than the cold ones', () => {
    show(new Set(['b']));

    expect(under('In memory')).toEqual(['Resident', 'Arriving']);
    expect(under('Not loaded')).toEqual(['Cold']);
  });

  it('counts it against what memory holds, which is what the cap is about', () => {
    show(new Set(['b']));

    expect(screen.getByText('In memory').closest('button')?.textContent).toContain('2');
  });

  it('leaves it where it was until it is asked for', () => {
    show(new Set());

    expect(under('In memory')).toEqual(['Resident']);
    expect(under('Not loaded')).toEqual(['Arriving', 'Cold']);
  });

  it('takes no set at all as nothing arriving', () => {
    show();

    expect(under('In memory')).toEqual(['Resident']);
  });

  /**
   * Read from the resume rather than from what the session is doing: a resume is the
   * lowest-ranked activity and is hidden the moment the session does anything, so one that
   * has already produced a question reads as blocked and would fall back out of the group.
   */
  it('keeps it there once it is busy enough to hide the resume', () => {
    render(
      <Sidebar
        sessions={mixed}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{ b: { state: 'blocked', queued: 0 } }}
        loading={new Set(['b'])}
      />,
    );

    expect(under('In memory')).toContain('Arriving');
  });

  /** Archiving hides nothing that is costing memory, however it came to be costing it. */
  it('takes it out of the archive while it arrives', () => {
    render(
      <Sidebar
        sessions={mixed}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        archived={['b']}
        loading={new Set(['b'])}
      />,
    );

    expect(under('In memory')).toContain('Arriving');
    expect(screen.queryByText('Archived')).toBeNull();
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
   * Subagents delegate in turn, so the list is a tree (#178). Drawn flat with the indent
   * carrying the nesting rather than as lists inside lists: a task is one option of the
   * sessions listbox now, and an option cannot hold a list of other options (#254).
   */
  describe('one delegated by another', () => {
    const family = [
      watched({ agentId: 'outer', name: 'outer-agent' }),
      watched({ agentId: 'inner', name: 'inner-agent', parentAgentId: 'outer' }),
    ];

    const named = (container: HTMLElement, name: string) =>
      [...container.querySelectorAll('.subagent-item')].find(
        (li) => li.querySelector('.subagent-name')?.textContent === name,
      ) as HTMLElement | undefined;

    it('draws it under the task that delegated it', () => {
      const { container } = shown({ subagents: family });

      const rows = [...container.querySelectorAll('.subagent-item')];
      expect(rows.indexOf(named(container, 'inner-agent')!), 'after the one that sent it').toBe(
        rows.indexOf(named(container, 'outer-agent')!) + 1,
      );
    });

    it('sets it in from the task that delegated it, which is what says who sent it', () => {
      const { container } = shown({ subagents: family });

      expect(named(container, 'outer-agent')!.style.paddingLeft).toBe('');
      expect(named(container, 'inner-agent')!.style.paddingLeft).toBe('12px');
    });

    /** One run of rows, not lists inside lists: an option cannot hold a list of options. */
    it('holds no list inside a task', () => {
      const { container } = shown({ subagents: family });

      expect(named(container, 'outer-agent')!.querySelectorAll('.subagent-list')).toHaveLength(0);
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

  /**
   * On the row rather than on the button inside it. The row is what carries the mark for a
   * screen reader and for the arrow-key cursor, and what the background has to cover: the
   * star and the cross sit outside that button (#260).
   */
  it('marks the one being read', () => {
    const { container } = shown({ subagents: [watched()], selectedSubagentId: 'a1' });
    expect(container.querySelector('.subagent-item[aria-selected="true"]')).toBeTruthy();
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

  /**
   * The cross rather than the multiplication sign. Measured in the app's own font at one
   * size, `×` inks 6x7px against the star's 15x15 and sits six pixels lower, because it is
   * an operator centred on the maths axis - so the pair read as a star beside a smudge.
   */
  it('dismisses with a cross the size of the star beside it', () => {
    const { container } = shown({
      subagents: [watched()],
      onDismissSubagent: () => {},
      onKeepSubagent: () => {},
      keepableSubagent: () => true,
    });

    expect(container.querySelector('.subagent-dismiss')?.textContent).toBe('\u2715');
    expect(
      container.querySelector('.subagent-dismiss')?.textContent,
      'the multiplication sign is a maths operator, not a control',
    ).not.toBe('\u00d7');
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

/**
 * A session another Copilot has open (#63).
 *
 * The app cannot stop it. Two Copilots in one conversation write to the same log and the
 * same database, so saying which sessions are in that state is the only useful thing left.
 */
describe('a session open somewhere else', () => {
  const marks = () => [...document.querySelectorAll('.session-elsewhere')];

  const drawn = (active: string[]) =>
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        activeElsewhere={active}
      />,
    );

  it('marks the one that is open elsewhere', () => {
    drawn(['f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8']);

    expect(marks()).toHaveLength(1);
  });

  it('marks it on its own row rather than on any other', () => {
    drawn(['f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8']);

    expect(marks()[0]?.closest('.session')?.textContent).toContain('Biomes');
  });

  it('leaves every other session unmarked', () => {
    drawn([]);

    expect(marks()).toHaveLength(0);
  });

  it('marks every one that is open elsewhere', () => {
    drawn(['f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8', '9ec04ce0-1361-4e11-ae34-9f8747cbac64']);

    expect(marks()).toHaveLength(2);
  });

  /** The warning is the reason the mark exists, so it has to say what the risk is. */
  it('says what being open twice would cost', () => {
    drawn(['f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8']);

    expect(marks()[0]?.getAttribute('title')).toContain('same conversation');
  });

  // Nothing is passed where the app has never managed to ask, which must not throw.
  it('draws nothing where it was told nothing', () => {
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
      />,
    );

    expect(marks()).toHaveLength(0);
  });
});

/**
 * Picking out several sessions to act on together (#63).
 *
 * Ctrl and Shift, because that is what every list on the machine does. A marked row is
 * drawn differently from the open one: they are different claims, and a reader who
 * confuses them deletes the wrong thing.
 */
describe('marking sessions in the list', () => {
  const drawn = (over: { marked?: string[]; onMark?: (id: string, keys: { toggle: boolean; range: boolean }, order: readonly string[]) => boolean } = {}) => {
    const onSelect = vi.fn();
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={onSelect}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        marked={over.marked}
        onMark={over.onMark}
      />,
    );
    return { onSelect, rows: () => [...document.querySelectorAll('.session-row')] };
  };

  const FIRST = 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8';

  it('hands a plain click to whatever opens a session', () => {
    const onMark = vi.fn(() => false);
    const t = drawn({ onMark });

    fireEvent.click(t.rows()[0]!);

    expect(onMark).toHaveBeenCalledWith(FIRST, { toggle: false, range: false }, expect.any(Array));
    expect(t.onSelect).toHaveBeenCalled();
  });

  it('passes on which modifiers a click carried', () => {
    const onMark = vi.fn(() => true);
    const t = drawn({ onMark });

    fireEvent.click(t.rows()[0]!, { ctrlKey: true });

    expect(onMark).toHaveBeenCalledWith(FIRST, { toggle: true, range: false }, expect.any(Array));
  });

  it('reads the Mac modifier as the same thing', () => {
    const onMark = vi.fn(() => true);
    const t = drawn({ onMark });

    fireEvent.click(t.rows()[0]!, { metaKey: true });

    expect(onMark).toHaveBeenCalledWith(FIRST, { toggle: true, range: false }, expect.any(Array));
  });

  it('passes on a range click', () => {
    const onMark = vi.fn(() => true);
    const t = drawn({ onMark });

    fireEvent.click(t.rows()[0]!, { shiftKey: true });

    expect(onMark).toHaveBeenCalledWith(FIRST, { toggle: false, range: true }, expect.any(Array));
  });

  /**
   * The order a range is measured over has to be the order on screen, which only this
   * knows: the list arrives in one order and is drawn grouped in another (#63).
   */
  it('hands over the rows in the order they are drawn', () => {
    const onMark = vi.fn((_id: string, _keys: { toggle: boolean; range: boolean }, _order: readonly string[]) => true);
    const t = drawn({ onMark });

    fireEvent.click(t.rows()[0]!, { shiftKey: true });

    const order = onMark.mock.calls[0]![2];
    const onScreen = [...document.querySelectorAll('.session-row .session-title')];
    expect(order).toHaveLength(onScreen.length);
    // Same rows, same sequence: the first drawn row is the first in the order handed over.
    expect(order[0]).toBe(FIRST);
  });

  /** Adding a session to a set is not asking to read it. */
  it('does not open a session the click only marked', () => {
    const t = drawn({ onMark: () => true });

    fireEvent.click(t.rows()[0]!, { ctrlKey: true });

    expect(t.onSelect).not.toHaveBeenCalled();
  });

  it('draws a marked row as marked', () => {
    drawn({ marked: [FIRST] });

    const marked = [...document.querySelectorAll('.session-row.marked')];
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain('Biomes');
  });

  it('draws nothing as marked when nothing is', () => {
    drawn({ marked: [] });

    expect(document.querySelectorAll('.session-row.marked')).toHaveLength(0);
  });

  it('still opens sessions where nothing is marking at all', () => {
    const t = drawn();

    fireEvent.click(t.rows()[0]!);

    expect(t.onSelect).toHaveBeenCalled();
  });
});

/**
 * The mark covers the whole entry (#63).
 *
 * It sat on the title button inside the row, so the star and the tags fell outside the
 * highlight and it read as having selected part of a session rather than all of one.
 */
describe('what a mark covers', () => {
  const FIRST = 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8';

  const drawn = () =>
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        marked={[FIRST]}
        onFavourite={() => {}}
        favourites={[FIRST]}
        tags={{ [FIRST]: ['hades'] }}
      />,
    );

  it('marks the row rather than the title inside it', () => {
    drawn();

    expect(document.querySelector('.session-row.marked')).toBeTruthy();
    expect(document.querySelector('.session.marked')).toBeNull();
  });

  it('takes in the star, which belongs to the session as much as its name', () => {
    drawn();

    expect(document.querySelector('.session-row.marked .favourite')).toBeTruthy();
  });

  it('takes in the tags', () => {
    drawn();

    expect(document.querySelector('.session-row.marked .session-tags .tag')).toBeTruthy();
  });
});

/**
 * Marking driven through the real hook, rather than a mock standing in for it (#63).
 *
 * The unit tests either side of this were both green while a Shift range marked nothing at
 * all: the hook was right about an order, the sidebar was right about drawing one, and
 * what they handed each other was never exercised.
 */
describe('marking a range, end to end', () => {
  const FAV = 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8';
  const OTHER = '9ec04ce0-1361-4e11-ae34-9f8747cbac64';

  function Harness({ favourites = [] as string[], selected = null as string | null }) {
    const listed = sessions.map((s) => s.sessionId);
    // Both, exactly as the window does it: the sidebar draws the open session and the hook
    // measures a range from it when nothing has been touched.
    const { marked, click } = useMarked(listed, selected);
    return (
      <Sidebar
        sessions={sessions}
        selectedId={selected}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        marked={marked}
        onMark={click}
        favourites={favourites}
        onFavourite={() => {}}
      />
    );
  }

  /** What a real click lands on: the title button inside the row, which bubbles up to it. */
  const titles = () => [...document.querySelectorAll('.session-row .session')];
  const markedTitles = () =>
    [...document.querySelectorAll('.session-row.marked .session-title')].map((n) => n.textContent?.trim());

  it('marks both ends of a range and what is between them', () => {
    render(<Harness />);

    fireEvent.click(titles()[0]!);
    fireEvent.click(titles()[1]!, { shiftKey: true });

    expect(markedTitles()).toHaveLength(2);
  });

  it('marks one that is ctrl-clicked', () => {
    render(<Harness />);

    fireEvent.click(titles()[0]!, { ctrlKey: true });

    expect(markedTitles()).toHaveLength(1);
  });

  /** The arrangement the bug was reported in: two groups, a range inside one of them. */
  it('marks a range across a grouped list', () => {
    render(<Harness favourites={[FAV, OTHER]} />);

    fireEvent.click(titles()[0]!);
    fireEvent.click(titles()[1]!, { shiftKey: true });

    expect(markedTitles()).toHaveLength(2);
  });

  /**
   * Reported as doing nothing but drawing a focus ring on the row that was clicked: a
   * reader opens a session, then reaches down the list holding Shift without having
   * clicked anything in between.
   */
  it('marks a range from the open session as the very first thing anybody does', () => {
    render(<Harness selected={FAV} />);

    fireEvent.click(titles()[1]!, { shiftKey: true });

    expect(markedTitles()).toHaveLength(2);
  });

  it('marks nothing where there is no open session to measure from either', () => {
    render(<Harness />);

    fireEvent.click(titles()[1]!, { shiftKey: true });

    expect(markedTitles()).toEqual([]);
  });
});

/**
 * Picking over the list rather than reading it (#63).
 *
 * Ctrl-click is the gesture every list on the machine uses, which is exactly why somebody
 * who has not met it has no way to find out it is there. Asked for by name, the rows grow
 * boxes and a plain click adds to the set - the same thing, for a reader who needs to see
 * it to know it is possible.
 */
describe('picking sessions with boxes', () => {
  const FIRST = 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8';

  const drawn = (over: {
    selecting?: boolean;
    marked?: string[];
    onMark?: (id: string, keys: { toggle: boolean; range: boolean }, order: readonly string[]) => boolean;
    onDoneSelecting?: () => void;
    selectionActions?: SessionAction[];
  }) => {
    const onSelect = vi.fn();
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={onSelect}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        selecting={over.selecting}
        marked={over.marked}
        onMark={over.onMark}
        onDoneSelecting={over.onDoneSelecting}
        selectionActions={over.selectionActions}
      />,
    );
    return { onSelect, boxes: () => [...document.querySelectorAll('.session-check')] };
  };

  it('draws no box while the list is only being read', () => {
    const t = drawn({ selecting: false });

    expect(t.boxes()).toHaveLength(0);
  });

  it('draws one on every row while picking', () => {
    const t = drawn({ selecting: true });

    expect(t.boxes()).toHaveLength(document.querySelectorAll('.session-row').length);
  });

  it('ticks the boxes of the rows that are picked', () => {
    const t = drawn({ selecting: true, marked: [FIRST] });

    const ticked = t.boxes().filter((box) => box.getAttribute('aria-checked') === 'true');
    expect(ticked).toHaveLength(1);
    expect(ticked[0]?.closest('.session-row')?.textContent).toContain('Biomes');
  });

  it('says what each box would do, since a tick is not a name', () => {
    const t = drawn({ selecting: true, marked: [FIRST] });

    expect(t.boxes()[0]?.getAttribute('aria-label')).toMatch(/^Deselect /);
  });

  it('says the other thing where a row is not picked', () => {
    const t = drawn({ selecting: true, marked: [] });

    expect(t.boxes()[0]?.getAttribute('aria-label')).toMatch(/^Select /);
  });

  it('marks the row whose box was pressed', () => {
    const onMark = vi.fn(() => true);
    const t = drawn({ selecting: true, onMark });

    fireEvent.click(t.boxes()[0]!);

    expect(onMark).toHaveBeenCalledWith(FIRST, { toggle: false, range: false }, expect.any(Array));
  });

  /** The row answers the same click, and answered twice it would tick and untick. */
  it('does not let the row answer the same press', () => {
    const onMark = vi.fn(() => true);
    const t = drawn({ selecting: true, onMark });

    fireEvent.click(t.boxes()[0]!);

    expect(onMark).toHaveBeenCalledOnce();
    expect(t.onSelect).not.toHaveBeenCalled();
  });

  it('carries the modifiers a press on a box held', () => {
    const onMark = vi.fn(() => true);
    const t = drawn({ selecting: true, onMark });

    fireEvent.click(t.boxes()[1]!, { shiftKey: true });

    expect(onMark).toHaveBeenCalledWith(expect.any(String), { toggle: false, range: true }, expect.any(Array));
  });

  describe('the bar above the list', () => {
    const bar = () => document.querySelector('.selecting-bar');

    it('is not there while the list is only being read', () => {
      drawn({ selecting: false, marked: [] });

      expect(bar()).toBeNull();
    });

    it('counts what has been picked', () => {
      drawn({ selecting: true, marked: [FIRST] });

      expect(bar()?.textContent).toContain('1 selected');
    });

    it('counts several', () => {
      drawn({ selecting: true, marked: [FIRST, '9ec04ce0-1361-4e11-ae34-9f8747cbac64'] });

      expect(bar()?.textContent).toContain('2 selected');
    });

    /** Named for what it does to the selection, which is undo it rather than finish it. */
    it('offers a way out', () => {
      const onDoneSelecting = vi.fn();
      drawn({ selecting: true, marked: [FIRST], onDoneSelecting });

      fireEvent.click(screen.getByText('Cancel'));

      expect(onDoneSelecting).toHaveBeenCalledOnce();
    });
  });

  /**
   * What can be done to the set, in the bar as well as in the menu (#63).
   *
   * Right-clicking a marked row is the other way to reach these, and it has the same
   * discoverability problem as Ctrl-click: a reader who got here by pressing Select… has
   * been given no reason to think a menu is involved.
   */
  describe('the actions in the bar', () => {
    const acting = () => [...document.querySelectorAll('.selecting-action')];

    const some = (): SessionAction[] => [
      { id: 'bulk-export', label: 'Export 2 sessions…', brief: 'Export…', run: vi.fn() },
      { id: 'bulk-archive', label: 'Archive 2 sessions', brief: 'Archive', tone: 'caution', run: vi.fn() },
      { id: 'bulk-delete', label: 'Delete 2 sessions', brief: 'Delete', tone: 'danger', run: vi.fn() },
    ];

    it('offers every one it was given', () => {
      drawn({ selecting: true, marked: [FIRST], selectionActions: some() });

      expect(acting().map((button) => button.textContent)).toEqual(['Export…', 'Archive', 'Delete']);
    });

    /** The bar is already saying how many, and five counted labels fit nowhere. */
    it('wears the short name and keeps the full one for the pointer', () => {
      drawn({ selecting: true, marked: [FIRST], selectionActions: some() });

      expect(acting()[2]?.textContent).toBe('Delete');
      expect(acting()[2]?.getAttribute('title')).toBe('Delete 2 sessions');
    });

    it('falls back to the full name where there is no short one', () => {
      drawn({
        selecting: true,
        marked: [FIRST],
        selectionActions: [{ id: 'bulk-odd', label: 'Something unusual', run: vi.fn() }],
      });

      expect(acting()[0]?.textContent).toBe('Something unusual');
    });

    it('runs the one that was pressed', () => {
      const actions = some();
      drawn({ selecting: true, marked: [FIRST], selectionActions: actions });

      fireEvent.click(acting()[0]!);

      expect(actions[0]?.run).toHaveBeenCalledOnce();
    });

    it('colours each by what it costs', () => {
      drawn({ selecting: true, marked: [FIRST], selectionActions: some() });

      expect(acting()[1]?.className).toContain('caution');
      expect(acting()[2]?.className).toContain('danger');
      expect(acting()[0]?.className).toBe('selecting-action');
    });

    /** Kept in the row and greyed, so the buttons do not move under the hand. */
    it('refuses one rather than dropping it, and says why', () => {
      const run = vi.fn();
      drawn({
        selecting: true,
        marked: [FIRST],
        selectionActions: [{ id: 'bulk-unload', label: 'Unload 0 from memory', brief: 'Unload', refused: 'None of these are in memory.', run }],
      });

      expect((acting()[0] as HTMLButtonElement).disabled).toBe(true);
      expect(acting()[0]?.getAttribute('title')).toBe('None of these are in memory.');

      fireEvent.click(acting()[0]!);
      expect(run).not.toHaveBeenCalled();
    });

    it('draws no buttons where it was given none', () => {
      drawn({ selecting: true, marked: [FIRST], selectionActions: [] });

      expect(acting()).toHaveLength(0);
      expect(document.querySelector('.selecting-bar')).toBeTruthy();
    });
  });
});

/**
 * Picking driven through the real hook, rather than a mock standing in for it (#63).
 *
 * The same lesson as the range above: two green unit tests either side of an interface say
 * nothing about what they hand each other.
 */
describe('picking over the list, end to end', () => {
  function Harness() {
    const listed = sessions.map((s) => s.sessionId);
    const { marked, selecting, click, start, clear } = useMarked(listed, null);
    return (
      <>
        <button type="button" onClick={() => start(listed[0]!)}>
          Select…
        </button>
        <Sidebar
          sessions={sessions}
          selectedId={null}
          onSelect={() => {}}
          onCreate={() => {}}
          onWiki={() => {}}
          creating={false}
          activity={{}}
          marked={marked}
          selecting={selecting}
          onMark={click}
          onDoneSelecting={clear}
        />
      </>
    );
  }

  const boxes = () => [...document.querySelectorAll('.session-check')];
  const titles = () => [...document.querySelectorAll('.session-row .session')];
  const marks = () => document.querySelectorAll('.session-row.marked').length;

  const begin = () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Select…'));
  };

  it('grows boxes on being asked, with the row asked about picked', () => {
    begin();

    expect(boxes()).toHaveLength(document.querySelectorAll('.session-row').length);
    expect(marks()).toBe(1);
  });

  it('adds a row to the set on a plain click, having opened nothing', () => {
    begin();

    fireEvent.click(titles()[1]!);

    expect(marks()).toBe(2);
  });

  it('adds a row on its box as readily as on the row', () => {
    begin();

    fireEvent.click(boxes()[1]!);

    expect(marks()).toBe(2);
  });

  it('takes a row back when it is clicked again', () => {
    begin();
    fireEvent.click(titles()[1]!);

    fireEvent.click(titles()[1]!);

    expect(marks()).toBe(1);
  });

  /** Nothing picked is not a selection, and a list where clicking opens nothing is a trap. */
  it('puts the boxes away once the last row is taken back', () => {
    begin();

    fireEvent.click(titles()[0]!);

    expect(boxes()).toHaveLength(0);
    expect(marks()).toBe(0);
  });

  it('puts them away when it is finished with', () => {
    begin();

    fireEvent.click(screen.getByText('Cancel'));

    expect(boxes()).toHaveLength(0);
    expect(marks()).toBe(0);
  });
});

/**
 * A pointer leaves no focus ring (#63).
 *
 * Chromium counts a Ctrl or Shift click as keyboard-ish and draws one, so marking a range
 * put a box around the last row touched while the row was already saying it was marked.
 * Focus still follows Tab, which is the case the ring exists for.
 */
describe('focus on a session row', () => {
  it('does not take focus from a click', () => {
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
      />,
    );
    const title = document.querySelector('.session-row .session') as HTMLElement;

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    title.dispatchEvent(down);

    expect(down.defaultPrevented).toBe(true);
  });
});

/**
 * Whether a session's tags are drawn on its row (#123).
 *
 * The chips are a second line under every row that carries any, and a sidebar is as narrow
 * as the reader has dragged it. Somebody who tags sessions to filter by them rather than to
 * read them should be able to have the width back.
 */
describe('tags on a row', () => {
  const FIRST = 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8';

  const drawn = (over: { showTags?: boolean; chosen?: string[] } = {}) => {
    const view = render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        tags={{ [FIRST]: ['hades', 'mod'] }}
        showTags={over.showTags}
      />,
    );
    return { view, chips: () => [...document.querySelectorAll('.session-tags .tag')] };
  };

  it('draws them by default, since a tag nobody sees is a tag nobody maintains', () => {
    const t = drawn();

    expect(t.chips().map((c) => c.textContent)).toEqual(['hades', 'mod']);
  });

  it('draws them when it is asked to', () => {
    const t = drawn({ showTags: true });

    expect(t.chips()).toHaveLength(2);
  });

  it('leaves them off the rows when it is not', () => {
    const t = drawn({ showTags: false });

    expect(t.chips()).toHaveLength(0);
  });

  /** The tags are still there: this is about the rows, not about the session. */
  it('still filters by a tag that is not drawn', async () => {
    drawn({ showTags: false });

    await userEvent.type(screen.getByPlaceholderText(/Filter by title/), 'tag:hades');

    expect(document.querySelectorAll('.session-row')).toHaveLength(1);
  });

  /**
   * Hidden means hidden, including a tag that is currently narrowing the list.
   *
   * The control that narrowed it already says so, in its own label and its count, so a row
   * repeating it would be ignoring the setting to say something already on screen.
   */
  it('keeps them off the rows even while one of them is filtering', async () => {
    const t = drawn({ showTags: false });

    await userEvent.click(screen.getByLabelText('Filter by tag'));
    await userEvent.click(screen.getByRole('button', { name: /hades/ }));

    expect(t.chips()).toHaveLength(0);
  });
});

/**
 * What a session last said, under its name (#240).
 *
 * A row is how somebody finds a session among two hundred, and a title the runtime wrote is
 * often the least distinguishing thing about it. How many lines of this to give up is the
 * reader's to decide, down to none at all.
 */
describe('the last reply on a row', () => {
  const FIRST = 'f1ec2c40-9eb5-4bc8-85b4-06f03ee654c8';
  const SECOND = '9ec04ce0-1361-4e11-ae34-9f8747cbac64';

  const drawn = (over: { previews?: Record<string, string>; previewLines?: number; onWatchRow?: () => void } = {}) => {
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        previews={over.previews ?? { [FIRST]: 'What it said last' }}
        previewLines={over.previewLines ?? 2}
        onWatchRow={over.onWatchRow}
      />,
    );
    return { said: () => [...document.querySelectorAll<HTMLElement>('.session-said')] };
  };

  it('draws what the session said', () => {
    const t = drawn();

    expect(t.said().map((p) => p.textContent)).toEqual(['What it said last']);
  });

  it('draws nothing on a row with no answer yet', () => {
    const t = drawn({ previews: {} });

    expect(t.said()).toHaveLength(0);
  });

  it('draws nothing at all when the reader asked for no lines', () => {
    const t = drawn({ previewLines: 0 });

    expect(t.said()).toHaveLength(0);
  });

  it('is absent by default, so a row costs nothing until it is asked for', () => {
    render(
      <Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} previews={{ [FIRST]: 'Unasked for' }} />,
    );

    expect(document.querySelectorAll('.session-said')).toHaveLength(0);
  });

  it.each([1, 2, 5])('clamps to the %i lines it was given', (lines) => {
    const t = drawn({ previewLines: lines });

    expect(t.said()[0]!.style.webkitLineClamp).toBe(String(lines));
  });

  it('draws one for every row that has an answer', () => {
    const t = drawn({ previews: { [FIRST]: 'One', [SECOND]: 'Two' } });

    expect(t.said().map((p) => p.textContent)).toEqual(['One', 'Two']);
  });

  it('says which rows are drawn, so only those are ever read', () => {
    const watched = new Set<string>();
    drawn({
      onWatchRow: ((id: string, node: Element | null) => node && watched.add(id)) as unknown as () => void,
    });

    expect([...watched].sort()).toEqual([SECOND, FIRST].sort());
  });

  /**
   * The watcher is told a row has gone by that row's ref being handed back empty, and React
   * hands a ref back whenever its identity changed. A row built with a fresh arrow each time
   * would therefore report itself gone on every render, and the list of what is on screen
   * would empty itself as fast as it filled.
   */
  it('keeps watching a row across a redraw rather than giving it back', () => {
    const calls: [string, boolean][] = [];
    const watch = ((id: string, node: Element | null) => calls.push([id, node !== null])) as unknown as () => void;
    const { rerender } = render(
      <Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} previewLines={2} onWatchRow={watch} />,
    );
    calls.length = 0;

    rerender(
      <Sidebar sessions={sessions} selectedId={'other' as string} onSelect={() => {}} onCreate={() => {}}
        onWiki={() => {}} creating={false} activity={{}} previewLines={2} onWatchRow={watch} />,
    );

    expect(calls.filter(([, attached]) => !attached)).toEqual([]);
  });

  it('draws it under the tags rather than over them', () => {
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        tags={{ [FIRST]: ['hades'] }}
        previews={{ [FIRST]: 'What it said last' }}
        previewLines={2}
      />,
    );
    const row = document.querySelector(`.session-row`)!;
    const parts = [...row.children].map((n) => n.className);

    expect(parts.indexOf('session-said')).toBeGreaterThan(parts.indexOf('session-tags'));
  });
});
/**
 * The sidebar is the app's primary navigation, and until now none of it could be reached
 * without a mouse: the rows were plain divs carrying a click (#247). The list holds one tab
 * stop and the arrows move it, which is what every list on the machine does.
 */
describe('reaching the session list without a mouse', () => {
  const rows = () => [...document.querySelectorAll('.session-row')] as HTMLElement[];
  const marks = () => document.querySelectorAll('.session-row.marked').length;

  function Harness({
    onSelect = () => {},
    selected = null as string | null,
  }: {
    onSelect?: ComponentProps<typeof Sidebar>['onSelect'];
    selected?: string | null;
  }) {
    const listed = sessions.map((s) => s.sessionId);
    const { marked, click } = useMarked(listed, selected);
    return (
      <Sidebar
        sessions={sessions}
        selectedId={selected}
        onSelect={onSelect}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        marked={marked}
        onMark={click}
      />
    );
  }

  it('holds one tab stop for the whole list rather than one per row', () => {
    render(<Harness />);

    expect(rows().length, 'the fixture needs more than one row to say anything').toBeGreaterThan(1);
    expect(rows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
  });

  it('starts the cursor on the session being read', () => {
    render(<Harness selected={sessions[1]!.sessionId} />);

    const stop = rows().find((row) => row.tabIndex === 0);

    expect(stop?.getAttribute('aria-selected'), 'the stop should be on the open session').toBe('true');
  });

  it('moves down the list on an arrow', () => {
    render(<Harness />);
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(rows()[1]);
  });

  it('moves back up again', () => {
    render(<Harness />);
    rows()[1]!.focus();

    fireEvent.keyDown(rows()[1]!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(rows()[0]);
  });

  /** Running off the bottom would take the focus out of the list and lose the reader. */
  it('stays on the last row rather than wrapping to the top', () => {
    render(<Harness />);
    const last = rows()[rows().length - 1]!;
    last.focus();

    fireEvent.keyDown(last, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(last);
  });

  /**
   * Up out of the top row is the box that narrowed the list down to it, which makes the way
   * in and the way out the same pair of keys.
   */
  it('goes back up into the filter box from the first row', () => {
    render(<Harness />);
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('jumps to the last row on End and back on Home', () => {
    render(<Harness />);
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'End' });
    expect(document.activeElement).toBe(rows()[rows().length - 1]);

    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(rows()[0]);
  });

  it('opens the row on Enter', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith(sessions[0]!.sessionId, expect.anything(), undefined, '');
  });

  it('marks the row on Space, having opened nothing', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: ' ' });

    expect(marks()).toBe(1);
    expect(onSelect, 'marking a row is not going to it').not.toHaveBeenCalled();
  });

  /** The same range the mouse gathers by dragging with Shift held, routed through onMark. */
  it('gathers a range as Shift holds the arrow down', () => {
    render(<Harness />);
    rows()[0]!.focus();
    fireEvent.keyDown(rows()[0]!, { key: ' ' });

    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown', shiftKey: true });

    expect(marks()).toBe(2);
  });

  /**
   * The journey that was severed outright: the box narrowed the list down and then there was
   * no way to act on what it found.
   */
  it('steps out of the filter box and into what it found', () => {
    render(<Harness />);
    const box = screen.getByRole('searchbox');
    box.focus();

    fireEvent.keyDown(box, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(rows()[0]);
  });

  it('offers the rows as options of a named list', () => {
    render(<Harness />);

    expect(screen.getByRole('listbox', { name: 'Sessions' })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(rows().length);
  });

  /**
   * A native tooltip is drawn by the window manager rather than by the page, so no selector
   * reaches one and nothing can say when it should appear. These carry their label in
   * `data-tip`, which the page draws on hover and on nothing else, so arriving at one with
   * the keyboard does not pop up a label nobody asked for. The name stays on the button for
   * anyone being read to.
   */
  it.each(['Settings', 'Wiki', 'Import', 'New'])('draws its own tooltip for %s', (name) => {
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        onSettings={() => {}}
        onImport={() => {}}
        creating={false}
        activity={{}}
      />,
    );
    const button = screen.getByRole('button', { name });

    expect(button.getAttribute('title'), 'the browser cannot be told when to draw one').toBeNull();
    expect(button.getAttribute('data-tip')).toBeTruthy();
  });
});

/**
 * The buttons along the top, which Tab reaches one at a time and the arrows walk as a row.
 *
 * Together with the list below them this makes the sidebar one column to walk down - the fold
 * control, then the filter box, then the sessions - rather than three places that each have
 * to be found.
 */
describe('reaching the buttons above the list', () => {
  const header = () => document.querySelector('.sidebar-header')!;
  const buttons = () => [...header().querySelectorAll('button')];

  const show = () =>
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        onSettings={() => {}}
        onImport={() => {}}
        onToggle={() => {}}
        creating={false}
        activity={{}}
        // The tag button only exists once something has been tagged, and it is one of the
        // two controls this is about.
        tags={{ [sessions[0]!.sessionId]: ['hades'] }}
      />,
    );

  it('goes up out of the filter box to the fold control', () => {
    show();
    const box = screen.getByRole('searchbox');
    box.focus();

    fireEvent.keyDown(box, { key: 'ArrowUp' });

    expect(document.activeElement, 'the first button along the top').toBe(buttons()[0]);
  });

  it('goes up out of the tag button to the same place', () => {
    show();
    const tags = screen.getByRole('button', { name: /Filter by tag/ });
    tags.focus();

    fireEvent.keyDown(tags, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(buttons()[0]);
  });

  it('walks right along the row', () => {
    show();
    buttons()[0]!.focus();

    fireEvent.keyDown(buttons()[0]!, { key: 'ArrowRight' });

    expect(document.activeElement).toBe(buttons()[1]);
  });

  it('walks back left again', () => {
    show();
    buttons()[1]!.focus();

    fireEvent.keyDown(buttons()[1]!, { key: 'ArrowLeft' });

    expect(document.activeElement).toBe(buttons()[0]);
  });

  /** A row this short is quicker to reach round the end than back through the middle. */
  it('comes round the end of the row', () => {
    show();
    const last = buttons()[buttons().length - 1]!;
    last.focus();

    fireEvent.keyDown(last, { key: 'ArrowRight' });

    expect(document.activeElement).toBe(buttons()[0]);
  });

  it('carries on down into the filter box', () => {
    show();
    buttons()[0]!.focus();

    fireEvent.keyDown(buttons()[0]!, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('leaves every one of them reachable by Tab as well', () => {
    show();

    expect(buttons().every((button) => button.tabIndex >= 0), 'the arrows are the shorter way, not the only one').toBe(
      true,
    );
  });

  /** An arrow inside the open tag list belongs to that list, not to the row behind it. */
  it('leaves the open tag list alone', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /Filter by tag/ }));
    // Scoped to the menu: the rows carry chips for the same tag, named the same way.
    const tag = within(document.querySelector('.tag-filter-menu') as HTMLElement).getByRole('button', {
      name: /hades/,
    });
    tag.focus();

    fireEvent.keyDown(tag, { key: 'ArrowUp' });

    expect(document.activeElement, 'still in the list it was opened to').toBe(tag);
  });
});

/**
 * The row menu had no keyboard route at all: `openMenu` takes a mouse event and places the
 * menu at the pointer, and Shift+F10 carries no pointer. Placed against the row instead, so
 * it opens on what it is about rather than in the corner of the window (#247).
 */
describe('opening a session row menu without a mouse', () => {
  const rows = () => [...document.querySelectorAll('.session-row')] as HTMLElement[];
  const menu = () => document.querySelector('.session-menu');

  const show = (onMenuOpened = vi.fn()) => {
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        actionsFor={() => [
          { id: 'a', label: 'Favourite', run: vi.fn() },
          { id: 'b', label: 'Rename', run: vi.fn() },
        ]}
        onMenuOpened={onMenuOpened}
      />,
    );
    return { onMenuOpened };
  };

  it.each([
    ['the Menu key', { key: 'ContextMenu' }],
    ['Shift+F10', { key: 'F10', shiftKey: true }],
  ])('opens on %s', (_what, init) => {
    show();
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, init);

    expect(menu()).toBeTruthy();
  });

  /** F10 alone is not it, and claiming it would take a key nothing here has a use for. */
  it('leaves plain F10 alone', () => {
    show();
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'F10' });

    expect(menu()).toBeNull();
  });

  it('asks what the session is before drawing the menu', () => {
    const { onMenuOpened } = show();
    rows()[1]!.focus();

    fireEvent.keyDown(rows()[1]!, { key: 'ContextMenu' });

    expect(onMenuOpened).toHaveBeenCalledWith(sessions[1]!.sessionId);
  });

  it('places the menu against the row rather than in the corner', () => {
    show();
    const row = rows()[0]!;
    row.getBoundingClientRect = () => ({ left: 40, top: 120, right: 0, bottom: 0, width: 0, height: 0, x: 40, y: 120, toJSON: () => '' });
    row.focus();

    fireEvent.keyDown(row, { key: 'ContextMenu' });

    const box = menu() as HTMLElement;
    expect(box.style.left, 'inset from the row it belongs to').toBe('52px');
    expect(box.style.top).toBe('132px');
  });

  it('hands the keyboard to the menu, which is the only place left for it', () => {
    show();
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'ContextMenu' });

    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
  });

  it('gives the row the keyboard back when the menu closes', async () => {
    show();
    const row = rows()[0]!;
    row.focus();
    fireEvent.keyDown(row, { key: 'ContextMenu' });

    fireEvent.keyDown(window, { key: 'Escape' });
    // A frame, because an action taken from the menu usually moves the row it was opened
    // from, so the keyboard is handed back only once the render that moves it has run.
    await act(async () => new Promise((done) => requestAnimationFrame(() => done(undefined))));

    expect(document.activeElement, 'back where it was before the menu').toBe(rows()[0]);
  });

  /** A menu that was pointed at did not take the keyboard, so it has none to give back. */
  it('leaves the keyboard alone when the menu was opened by a right-click', () => {
    show();
    const box = screen.getByRole('searchbox');
    box.focus();
    fireEvent.contextMenu(rows()[0]!, { button: 2, clientX: 30, clientY: 30 });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(document.activeElement).toBe(box);
  });
});

/**
 * A group's header is a stop of its own, so a group can be folded on the way past rather than
 * walked through. Without it the arrows ran from the last row of one group straight into the
 * first of the next, and a long group had to be crossed row by row.
 */
describe('stopping on a group on the way down the list', () => {
  /** Two groups: one loaded session, one that is not. */
  const grouped = [
    session({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Resident', loaded: true }),
    session({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', title: 'Cold' }),
  ];

  const show = () =>
    render(
      <Sidebar
        sessions={grouped}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
      />,
    );

  const headers = () => [...document.querySelectorAll('button.group')] as HTMLElement[];
  const rows = () => [...document.querySelectorAll('.session-row')] as HTMLElement[];

  it('draws a header for each group, with the rows under it', () => {
    show();

    expect(headers().length, 'the fixture needs two groups to say anything').toBe(2);
  });

  it('goes from a group to its first row', () => {
    show();
    headers()[0]!.focus();

    fireEvent.keyDown(headers()[0]!, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(rows()[0]);
  });

  it('reaches the next group rather than jumping over it into its rows', () => {
    show();
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown' });

    expect(document.activeElement, 'the header of the group below').toBe(headers()[1]);
  });

  it('comes back up to the group a row belongs to', () => {
    show();
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(headers()[0]);
  });

  /** Which is the whole point of stopping here: fold it and its rows are no longer in the way. */
  it('skips the rows of a group that has been folded', () => {
    show();
    fireEvent.click(headers()[0]!);
    headers()[0]!.focus();

    fireEvent.keyDown(headers()[0]!, { key: 'ArrowDown' });

    expect(document.activeElement, 'straight on to the next group').toBe(headers()[1]);
  });

  it('leaves Enter to the button, which is what folds the group', () => {
    show();
    headers()[0]!.focus();

    fireEvent.keyDown(headers()[0]!, { key: 'Enter' });

    expect(document.activeElement, 'still on the header it folded').toBe(headers()[0]);
  });

  /**
   * A header is not a session, so there is nothing about it to add to a set. Asking anyway
   * marked whatever `group:key` happened to match, which is nothing at all - and the row the
   * reader was reaching for was skipped over.
   */
  it('gathers only rows when Shift carries the arrow across a group', () => {
    const marked: string[] = [];
    render(
      <Sidebar
        sessions={grouped}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        marked={marked}
        onMark={(id) => {
          marked.push(id);
          return true;
        }}
      />,
    );
    rows()[0]!.focus();

    // Down from the first row lands on the next group's header, and down again on its row.
    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', shiftKey: true });

    expect(marked, 'the header is not something a range can include').toEqual([
      grouped[1]!.sessionId,
    ]);
  });

  it('holds the one tab stop between the headers and the rows', () => {
    show();

    const stops = [...headers(), ...rows()].filter((node) => node.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  it('steps out of the filter box onto the first group', () => {
    show();
    const box = screen.getByRole('searchbox');
    box.focus();

    fireEvent.keyDown(box, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(headers()[0]);
  });
});

/** Plain F10 reaches a menu bar this app does not have, and took the keyboard off the row. */
describe('F10 on a session row', () => {
  const rows = () => [...document.querySelectorAll('.session-row')] as HTMLElement[];

  const show = () =>
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        actionsFor={() => [{ id: 'a', label: 'Favourite', run: vi.fn() }]}
      />,
    );

  it('is claimed, so the window cannot take the keyboard away with it', () => {
    show();
    rows()[0]!.focus();

    const event = new KeyboardEvent('keydown', { key: 'F10', bubbles: true, cancelable: true });
    rows()[0]!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('still opens nothing on its own', () => {
    show();
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'F10' });

    expect(document.querySelector('.session-menu')).toBeNull();
  });

  /** The reported sequence: F10 took the focus, so the Shift+F10 after it pressed on nothing. */
  it('leaves Shift+F10 working immediately afterwards', () => {
    show();
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'F10' });
    fireEvent.keyDown(rows()[0]!, { key: 'F10', shiftKey: true });

    expect(document.querySelector('.session-menu')).toBeTruthy();
  });
});

/**
 * A range with nothing marked yet is measured from the session being read, which is what a
 * Shift-click after opening one means. An arrow is different: it is pressed on a row the
 * cursor is already on, and that row can be the length of the list away from the open one -
 * so Shift and an arrow swept up everything in between.
 */
describe('extending a selection with Shift and an arrow', () => {
  const many = ['One', 'Two', 'Three', 'Four', 'Five'].map((title, index) =>
    session({ sessionId: `0000000${index}-0000-4000-8000-00000000000${index}`, title }),
  );

  const rows = () => [...document.querySelectorAll('.session-row')] as HTMLElement[];
  const markedTitles = () =>
    [...document.querySelectorAll('.session-row.marked .session-title')].map((n) => n.textContent?.trim());

  function Harness({ open }: { open: string | null }) {
    const { marked, click } = useMarked(
      many.map((s) => s.sessionId),
      open,
    );
    return (
      <Sidebar
        sessions={many}
        selectedId={open}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        marked={marked}
        onMark={click}
      />
    );
  }

  it('takes only the row it came from and the one it reached', () => {
    render(<Harness open={many[0]!.sessionId} />);
    // Four rows away from the session being read, which is the whole point.
    rows()[4]!.focus();

    fireEvent.keyDown(rows()[4]!, { key: 'ArrowUp', shiftKey: true });

    expect(markedTitles(), 'not everything back to the open one').toEqual(['Four', 'Five']);
  });

  it('carries on from there rather than starting again', () => {
    render(<Harness open={many[0]!.sessionId} />);
    rows()[4]!.focus();

    fireEvent.keyDown(rows()[4]!, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', shiftKey: true });

    expect(markedTitles()).toEqual(['Three', 'Four', 'Five']);
  });

  /**
   * Marking by hand first is the other way in, and it says where the range starts too. The
   * row the cursor is on is not the anchor then - the one that was marked is, which is how
   * the same gesture behaves with a pointer.
   */
  it('measures from a row that was marked with Space', () => {
    render(<Harness open={many[0]!.sessionId} />);
    rows()[2]!.focus();
    fireEvent.keyDown(rows()[2]!, { key: ' ' });

    fireEvent.keyDown(rows()[2]!, { key: 'ArrowDown', shiftKey: true });

    expect(markedTitles()).toEqual(['Three', 'Four']);
  });

  it('keeps measuring from there after the cursor has moved on alone', () => {
    render(<Harness open={many[0]!.sessionId} />);
    rows()[1]!.focus();
    fireEvent.keyDown(rows()[1]!, { key: ' ' });
    // Moved without Shift, which is a change of where the keyboard is rather than of what
    // is picked out - so the row marked a moment ago is still the end being measured from.
    fireEvent.keyDown(rows()[1]!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', shiftKey: true });

    expect(markedTitles(), 'the whole span back to the row that was marked').toEqual([
      'Two',
      'Three',
      'Four',
      'Five',
    ]);
  });

  it('leaves the selection alone when no shift is held', () => {
    render(<Harness open={many[0]!.sessionId} />);
    rows()[4]!.focus();

    fireEvent.keyDown(rows()[4]!, { key: 'ArrowUp' });

    expect(markedTitles()).toEqual([]);
  });
});

/**
 * A row is one option of a list, and an option is not allowed to hold controls. Tab stopped
 * three times on every row - the title, then the star, then the next row's title - which on a
 * list of hundreds is a very long way to anywhere (#247).
 *
 * Nothing is lost by it. Favouriting is on the row's own menu, filtering by a tag is what the
 * control beside the search box does, and Space on the row marks it.
 */
describe('what a session row holds', () => {
  const show = () =>
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        favourites={[]}
        onFavourite={() => {}}
        tags={{ [sessions[0]!.sessionId]: ['hades', 'mod'] }}
        showTags
        marked={[sessions[0]!.sessionId]}
        selecting
        onMark={() => true}
      />,
    );

  const rows = () => [...document.querySelectorAll('.session-row')] as HTMLElement[];

  it('draws the controls it always did', () => {
    show();

    expect(document.querySelector('.favourite'), 'a star to click').toBeTruthy();
    expect(document.querySelector('.session-check'), 'a box to tick').toBeTruthy();
    expect(document.querySelector('.session-tags .tag'), 'a tag to filter by').toBeTruthy();
  });

  it('keeps none of them in the way of Tab', () => {
    show();

    const inside = rows().flatMap((row) => [...row.querySelectorAll<HTMLElement>('button, a[href], input')]);
    expect(inside.length, 'the fixture needs controls inside a row to say anything').toBeGreaterThan(0);
    expect(inside.filter((node) => node.tabIndex >= 0)).toEqual([]);
  });

  it('is itself the only thing in the list the keyboard stops on', () => {
    show();

    const stops = [...document.querySelectorAll<HTMLElement>('.session-list *')].filter(
      (node) => node.tabIndex === 0,
    );
    expect(stops.every((node) => node.classList.contains('session-row'))).toBe(true);
  });
});

/**
 * A session's delegated tasks are drawn under it, and the arrows used to step over them: the
 * cursor walked a list of stops that sessions were in and tasks were not. They are options of
 * the same listbox now, which is also what makes the markup valid - the buttons used to sit
 * inside the listbox belonging to no option at all (#254).
 */
describe('walking into what a session delegated', () => {
  const watched = (over: Record<string, unknown> = {}) => ({
    agentId: 'a1',
    sessionId: sessions[0]!.sessionId,
    name: 'deep-audit',
    events: [],
    ...over,
  });

  const family = [
    watched({ agentId: 'outer', name: 'outer-agent', sessionId: sessions[0]!.sessionId }),
    watched({ agentId: 'inner', name: 'inner-agent', parentAgentId: 'outer', sessionId: sessions[0]!.sessionId }),
  ];

  const show = (over: Partial<ComponentProps<typeof Sidebar>> = {}) =>
    render(
      <Sidebar
        sessions={sessions}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onWiki={() => {}}
        creating={false}
        activity={{}}
        subagents={family}
        onSelectSubagent={() => {}}
        {...over}
      />,
    );

  const rows = () => [...document.querySelectorAll('.session-row')] as HTMLElement[];
  const tasks = () => [...document.querySelectorAll('.subagent-item')] as HTMLElement[];

  it('reaches the first task from the session that delegated it', () => {
    show();
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(tasks()[0]);
  });

  it('walks from one task to the next', () => {
    show();
    tasks()[0]!.focus();

    fireEvent.keyDown(tasks()[0]!, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(tasks()[1]);
  });

  it('comes back up out of them to the session', () => {
    show();
    tasks()[0]!.focus();

    fireEvent.keyDown(tasks()[0]!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(rows()[0]);
  });

  it('carries on past them to the next session', () => {
    show();
    tasks()[1]!.focus();

    fireEvent.keyDown(tasks()[1]!, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(rows()[1]);
  });

  it('opens what a task did on Enter', () => {
    const onSelectSubagent = vi.fn();
    show({ onSelectSubagent });
    tasks()[0]!.focus();

    fireEvent.keyDown(tasks()[0]!, { key: 'Enter' });

    expect(onSelectSubagent).toHaveBeenCalledWith('outer');
  });

  /** A range is a range of sessions, and a task is not one of those. */
  it('steps over them when Shift carries the arrow down', () => {
    const marked: string[] = [];
    show({
      marked,
      onMark: (id) => {
        marked.push(id);
        return true;
      },
    });
    rows()[0]!.focus();

    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown', shiftKey: true });

    expect(marked, 'nothing gathered for a task').toEqual([]);
  });

  it('holds the one tab stop between the sessions and their tasks', () => {
    show();

    const stops = [...rows(), ...tasks()].filter((node) => node.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  it('offers them as a group of the same list rather than loose inside it', () => {
    show();

    const group = document.querySelector('.subagent-list');
    expect(group?.getAttribute('role'), 'a listbox may hold groups of options').toBe('group');
    expect(tasks().every((task) => task.getAttribute('role') === 'option')).toBe(true);
  });

  it('keeps their own controls out of the way of Tab', () => {
    show({ onKeepSubagent: () => {}, keepableSubagent: () => true, onDismissSubagent: () => {} });

    const inside = tasks().flatMap((task) => [...task.querySelectorAll<HTMLElement>('button')]);
    expect(inside.length, 'the fixture needs controls inside a task to say anything').toBeGreaterThan(0);
    expect(inside.filter((node) => node.tabIndex >= 0)).toEqual([]);
  });

  it('opens a task menu from the keyboard, since its controls are no longer stops', () => {
    show({ subagentActionsFor: () => [{ id: 'keep', label: 'Keep', run: vi.fn() }] });
    tasks()[0]!.focus();

    fireEvent.keyDown(tasks()[0]!, { key: 'ContextMenu' });

    expect(document.querySelector('.session-menu')).toBeTruthy();
  });
});
