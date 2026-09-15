import { useEffect, useRef, useState } from 'react';

import { messageOf } from './errors';
import { listMcpServers } from './sidecar';
import type { McpServerSummary } from '../../shared/protocol';

/**
 * The MCP servers there are, fetched the first time a command asks for one.
 *
 * Not fetched on mount: most sessions are read without `/mcp` ever being typed, and the
 * list costs a running server the same way the command list does. Held once it arrives,
 * since which servers are configured changes about as often as the commands do and a
 * half-typed argument is no moment to wait on a round trip.
 *
 * What is already held is the guard against asking twice, rather than a flag saying a
 * request is in flight. A flag was wrong in the one way that matters here: React tears an
 * effect down and sets it up again on mount, so the first attempt was marked stale and the
 * second found the flag still raised and did nothing at all. The list stayed empty, nothing
 * failed, and the menu had no way to say so - which is the worst shape a bug can take.
 *
 * Failure is reported through the caller rather than swallowed. A completion that silently
 * offers nothing is indistinguishable from a machine with no servers configured.
 */
export function useMcpServers(cwd: string | null, wanted: boolean, onError: (message: string) => void) {
  const [servers, setServers] = useState<McpServerSummary[] | null>(null);
  const report = useRef(onError);
  report.current = onError;

  // A different directory can discover different servers, so what was held describes the
  // one it was read for and nothing else.
  useEffect(() => setServers(null), [cwd]);

  useEffect(() => {
    if (!wanted || servers !== null) return;

    let current = true;
    listMcpServers(cwd ?? undefined)
      .then((found) => {
        if (current) setServers(found);
      })
      .catch((error: unknown) => {
        if (current) report.current(`Could not list MCP servers: ${messageOf(error)}`);
      });

    return () => {
      current = false;
    };
  }, [wanted, servers, cwd]);

  return servers;
}
