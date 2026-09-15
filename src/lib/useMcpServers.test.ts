// @vitest-environment jsdom
import { StrictMode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMcpServers } from './useMcpServers';

const { listMcpServers } = vi.hoisted(() => ({ listMcpServers: vi.fn() }));

vi.mock('./sidecar', () => ({ listMcpServers: (cwd?: string) => listMcpServers(cwd) }));

const servers = [{ name: 'context7', type: 'http', source: 'user', enabled: true }];

beforeEach(() => {
  listMcpServers.mockReset().mockResolvedValue(servers);
});

describe('the MCP servers a command can be completed with', () => {
  it('asks for nothing until something wants them', () => {
    renderHook(() => useMcpServers('C:\\repo', false, vi.fn()));

    expect(listMcpServers).not.toHaveBeenCalled();
  });

  it('reads them for the directory it was given', async () => {
    const { result } = renderHook(() => useMcpServers('C:\\repo', true, vi.fn()));

    await waitFor(() => expect(result.current).toEqual(servers));
    expect(listMcpServers).toHaveBeenCalledWith('C:\\repo');
  });

  /**
   * The bug this hook shipped with. React tears an effect down and sets it up again on
   * mount, and a flag saying "a request is in flight" survived the teardown: the first
   * attempt was marked stale and the second found the flag raised and did nothing. The
   * list stayed empty for good, nothing failed, and the menu had no way to say so.
   */
  it('still arrives when the effect is torn down and set up again', async () => {
    const { result } = renderHook(() => useMcpServers('C:\\repo', true, vi.fn()), { wrapper: StrictMode });

    await waitFor(() => expect(result.current).toEqual(servers));
  });

  it('holds what it read rather than asking again', async () => {
    const { result, rerender } = renderHook(({ cwd }) => useMcpServers(cwd, true, vi.fn()), {
      initialProps: { cwd: 'C:\\repo' },
    });
    await waitFor(() => expect(result.current).toEqual(servers));

    rerender({ cwd: 'C:\\repo' });
    expect(listMcpServers).toHaveBeenCalledTimes(1);
  });

  // Another directory can discover different servers, so what was held describes that one.
  it('reads again for a different directory', async () => {
    const { result, rerender } = renderHook(({ cwd }) => useMcpServers(cwd, true, vi.fn()), {
      initialProps: { cwd: 'C:\\repo' },
    });
    await waitFor(() => expect(result.current).toEqual(servers));

    rerender({ cwd: 'C:\\elsewhere' });
    await waitFor(() => expect(listMcpServers).toHaveBeenLastCalledWith('C:\\elsewhere'));
  });

  /** Offering nothing silently is indistinguishable from a machine with no servers. */
  it('reports a failure rather than looking like an empty list', async () => {
    listMcpServers.mockRejectedValue(new Error('no runtime'));
    const onError = vi.fn();
    const { result } = renderHook(() => useMcpServers('C:\\repo', true, onError));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Could not list MCP servers: no runtime'));
    expect(result.current).toBeNull();
  });

  it('asks without a directory when there is none', async () => {
    renderHook(() => useMcpServers(null, true, vi.fn()));

    await waitFor(() => expect(listMcpServers).toHaveBeenCalledWith(undefined));
  });
});
