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
 * Failure is reported through the caller rather than swallowed. A completion that silently
 * offers nothing is indistinguishable from a machine with no servers configured.
 */
export function useMcpServers(cwd: string | null, wanted: boolean, onError: (message: string) => void) {
  const [servers, setServers] = useState<McpServerSummary[] | null>(null);
  const asking = useRef(false);
  const report = useRef(onError);
  report.current = onError;

  // A different directory can discover different servers, so what was held describes the
  // one it was read for and nothing else.
  useEffect(() => {
    setServers(null);
    asking.current = false;
  }, [cwd]);

  useEffect(() => {
    if (!wanted || servers !== null || asking.current) return;

    asking.current = true;
    let current = true;

    listMcpServers(cwd ?? undefined)
      .then((found) => current && setServers(found))
      .catch((error: unknown) => {
        if (!current) return;
        asking.current = false;
        report.current(`Could not list MCP servers: ${messageOf(error)}`);
      });

    return () => {
      current = false;
    };
  }, [wanted, servers, cwd]);

  return servers;
}
