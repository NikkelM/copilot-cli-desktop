// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMcp } from './useMcp';

const sidecar = vi.hoisted(() => ({
  mcpStatus: vi.fn(),
  mcpLogin: vi.fn(),
  setMcpEnabled: vi.fn(),
  saveMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
}));

vi.mock('./sidecar', () => sidecar);

const state = [{ name: 'context7', status: 'connected', tools: 2 }];

/** The three callers App hands in, gathered so a test can read what each was told. */
const wiring = () => {
  const reload = vi.fn(() => Promise.resolve());
  const report = vi.fn();
  const openPage = vi.fn(() => Promise.resolve());
  return { reload, report, openPage };
};

const draw = (sessionId: string | null, given = wiring()) => ({
  given,
  ...renderHook(({ id }) => useMcp(id, given.reload, given.report, given.openPage), {
    initialProps: { id: sessionId },
  }),
});

beforeEach(() => {
  sidecar.mcpStatus.mockReset().mockResolvedValue(state);
  sidecar.mcpLogin.mockReset().mockResolvedValue('https://example.test/auth');
  sidecar.setMcpEnabled.mockReset().mockResolvedValue(undefined);
  sidecar.saveMcpServer.mockReset().mockResolvedValue(undefined);
  sidecar.removeMcpServer.mockReset().mockResolvedValue(undefined);
});

describe('what the MCP servers are doing', () => {
  it('asks for the session on screen', async () => {
    const { result } = draw('abc');
    await waitFor(() => expect(result.current.status).toEqual(state));
    expect(sidecar.mcpStatus).toHaveBeenCalledWith('abc');
  });

  it('asks nothing when there is no session to ask about', () => {
    draw(null);
    expect(sidecar.mcpStatus).not.toHaveBeenCalled();
  });

  /** A panel without dots beats an error over a list that is still true. */
  it('says nothing when the status cannot be read', async () => {
    sidecar.mcpStatus.mockRejectedValue(new Error('not loaded'));
    const { result, given } = draw('abc');

    await waitFor(() => expect(sidecar.mcpStatus).toHaveBeenCalled());
    expect(result.current.status).toBeNull();
    expect(given.report).not.toHaveBeenCalled();
  });

  it('drops one session\'s answer when another is shown', async () => {
    const { result, rerender } = draw('abc');
    await waitFor(() => expect(result.current.status).toEqual(state));

    rerender({ id: 'def' });
    expect(result.current.status).toBeNull();
  });
});

/**
 * The runtime owns the config file and the disabled list, so there is nothing here to
 * update optimistically: each change reads the panel again, and that reread is the only
 * account of what took.
 */
describe('changing a server', () => {
  it('turns one on, then reads the panel again', async () => {
    const { result, given } = draw('abc');
    await act(async () => void (await result.current.toggle('context7', false)));

    expect(sidecar.setMcpEnabled).toHaveBeenCalledWith('context7', false);
    expect(given.reload).toHaveBeenCalled();
  });

  it('writes one down, then reads the panel again', async () => {
    const config = { transport: 'http' as const, url: 'https://example.test' };
    const { result, given } = draw('abc');
    await act(async () => void (await result.current.save('new', config)));

    expect(sidecar.saveMcpServer).toHaveBeenCalledWith('new', config);
    expect(given.reload).toHaveBeenCalled();
  });

  it('takes one away, then reads the panel again', async () => {
    const { result, given } = draw('abc');
    await act(async () => void (await result.current.remove('context7')));

    expect(sidecar.removeMcpServer).toHaveBeenCalledWith('context7');
    expect(given.reload).toHaveBeenCalled();
  });

  it('says what went wrong, and does not claim the panel is now right', async () => {
    sidecar.saveMcpServer.mockRejectedValue(new Error('the config file is read-only'));
    const { result, given } = draw('abc');

    await act(async () => void (await result.current.save('new', { transport: 'http', url: 'x' })));

    expect(given.report).toHaveBeenLastCalledWith(expect.stringContaining('read-only'));
    expect(given.reload).not.toHaveBeenCalled();
  });

  // Otherwise the last failure sits over a change that has just worked.
  it('clears the last failure before trying again', async () => {
    const { result, given } = draw('abc');
    await act(async () => void (await result.current.remove('context7')));

    expect(given.report).toHaveBeenCalledWith(null);
  });
});

describe('signing in', () => {
  it('opens the page the runtime asks for', async () => {
    const { result, given } = draw('abc');
    await act(async () => void (await result.current.signIn('abc', 'context7')));

    expect(sidecar.mcpLogin).toHaveBeenCalledWith('abc', 'context7');
    expect(given.openPage).toHaveBeenCalledWith('https://example.test/auth');
  });

  // A button that did nothing would read as a sign-in that silently failed.
  it('says so when there is no page to open', async () => {
    sidecar.mcpLogin.mockResolvedValue(null);
    const { result, given } = draw('abc');

    await act(async () => void (await result.current.signIn('abc', 'context7')));

    expect(given.openPage).not.toHaveBeenCalled();
    expect(given.report).toHaveBeenLastCalledWith(expect.stringContaining('did not ask for a sign-in page'));
  });

  it('says what went wrong when the sign-in could not start', async () => {
    sidecar.mcpLogin.mockRejectedValue(new Error('server is not running'));
    const { result, given } = draw('abc');

    await act(async () => void (await result.current.signIn('abc', 'context7')));

    expect(given.report).toHaveBeenLastCalledWith(expect.stringContaining('not running'));
  });
});

describe('the form the panel is showing', () => {
  it('shows none until one is asked for', () => {
    const { result } = draw('abc');
    expect(result.current.editing).toBeNull();
  });

  it('opens the one it is given', () => {
    const { result } = draw('abc');
    act(() => result.current.edit('context7'));
    expect(result.current.editing).toBe('context7');
  });

  /** `/mcp add` with no name opens an empty form, which is not the same as no form. */
  it('tells an empty form apart from no form', () => {
    const { result } = draw('abc');
    act(() => result.current.edit(''));
    expect(result.current.editing).toBe('');
  });
});

/**
 * App subscribes to the runtime once, when it starts, and holds whatever callbacks it was
 * given then for the rest of the run. One that changes identity when the reader opens
 * another session is therefore one the subscription will never be handed again: it goes on
 * answering for whichever session was open at the moment the app started, which was none.
 *
 * That is how the live half of the todo list came to have never worked. The rule is cheap to
 * state and cheap to check, so it is checked here rather than left to be remembered.
 */describe('the identity App subscribes with', () => {
  it('survives the reader moving to another session', () => {
    const view = draw('s1');
    const { reread } = view.result.current;

    view.rerender({ id: 's2' });

    expect(view.result.current.reread).toBe(reread);
  });
});