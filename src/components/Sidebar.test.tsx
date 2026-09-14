// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './Sidebar';
import type { SessionSummary } from '../../shared/protocol';

const findSessions = vi.hoisted(() => vi.fn());
vi.mock('../lib/sidecar', () => ({ findSessions: (prefix: string) => findSessions(prefix) }));

const pickFolder = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args: unknown[]) => pickFolder(...args) }));

beforeEach(() => {
  findSessions.mockReset().mockResolvedValue({ sessions: [] });
  pickFolder.mockReset().mockResolvedValue(null);
});

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    sessionId: '00000000-0000-0000-0000-000000000000',
    title: 'Untitled',
    cwd: null,
    repository: null,
    branch: null,
    preview: null,
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
  render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}} creating={false} activity={{}} />);
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
      <Sidebar sessions={sessions} selectedId={null} onSelect={onSelect} onCreate={() => {}} creating={false} activity={{}} />,
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
        creating={false}
        activity={{ a: { state: 'working', queued: 0 } }}
      />,
    );
    expect(container.querySelector('.mark')).toBeNull();
  });
});


/**
 * Starting a session in a chosen folder (#25). The folder decides which instructions, skills
 * and agents the session loads, so it has to be settled before the first message rather than
 * moved afterwards.
 */
describe('starting a session in a folder', () => {
  const start = (onCreate: (dir?: string) => void, onError?: (message: string) => void) => {
    render(
      <Sidebar
        sessions={[]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={onCreate}
        creating={false}
        activity={{}}
        onError={onError}
      />,
    );
    return screen.getByLabelText('Start a new session in a folder');
  };

  it('starts the session in the folder that was picked', async () => {
    const onCreate = vi.fn();
    pickFolder.mockResolvedValue('C:\\work\\repo');

    await userEvent.click(start(onCreate));

    expect(pickFolder).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(onCreate).toHaveBeenCalledWith('C:\\work\\repo');
  });

  /** Dismissing the picker means the reader changed their mind, not that they want a session. */
  it('starts nothing when the picker is dismissed', async () => {
    const onCreate = vi.fn();
    pickFolder.mockResolvedValue(null);

    await userEvent.click(start(onCreate));

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('reports a picker that fails rather than starting a session somewhere else', async () => {
    const onCreate = vi.fn();
    const onError = vi.fn();
    pickFolder.mockRejectedValue(new Error('no picker'));

    await userEvent.click(start(onCreate, onError));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('no picker'));
    expect(onCreate).not.toHaveBeenCalled();
  });

  /**
   * The plain button takes no folder. It is a click handler, so without the wrapper it would
   * hand the mouse event to a parameter that expects a path.
   */
  it('asks for no folder at all from the plain button', async () => {
    const onCreate = vi.fn();
    render(
      <Sidebar
        sessions={[]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={onCreate}
        creating={false}
        activity={{}}
      />,
    );

    await userEvent.click(screen.getByText('New'));

    expect(pickFolder).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith();
  });
});