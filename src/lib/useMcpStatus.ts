import { useCallback, useEffect, useRef, useState } from 'react';

import { mcpStatus } from './sidecar';
import type { McpServerState } from '../../shared/protocol';

/**
 * What each MCP server is actually doing in the session being looked at.
 *
 * Null until it has been asked, and null for a session that is not loaded - which is not a
 * failure but the usual case. No session is ever resumed to answer: connection state is
 * something a reader would like to see rather than something they asked for, and starting a
 * process for that is the thing this app exists to avoid (#24).
 *
 * Read when the panel opens, and again whenever the runtime says a server changed. The
 * events are the only reason this is worth holding rather than fetching once: a server that
 * is still connecting answers `pending` and would stay that way on screen for ever.
 */
export function useMcpStatus(sessionId: string | null) {
  const [status, setStatus] = useState<McpServerState[] | null>(null);
  /** Which session the held answer describes, so a slow reply cannot land on another. */
  const showing = useRef(sessionId);
  showing.current = sessionId;

  const read = useCallback(() => {
    const asked = showing.current;
    if (!asked) {
      setStatus(null);
      return;
    }

    void mcpStatus(asked)
      .then((found) => {
        if (showing.current === asked) setStatus(found);
      })
      // A status nobody can read is a panel without dots rather than an error over the
      // list: the configured view beside it is still true and still worth reading.
      .catch(() => undefined);
  }, []);

  // A different session has a different answer, and the old one must not be shown against it.
  useEffect(() => {
    setStatus(null);
    read();
  }, [sessionId, read]);

  return { status, reread: read };
}
