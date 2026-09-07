// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  render(<Sidebar sessions={sessions} selectedId={null} onSelect={() => {}} onCreate={() => {}} creating={false} />);
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
      <Sidebar sessions={sessions} selectedId={null} onSelect={onSelect} onCreate={() => {}} creating={false} />,
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
      />,
    );

    expect(screen.queryByText('In memory')).toBeNull();
    expect(screen.queryByText('Not loaded')).toBeNull();
  });
});
