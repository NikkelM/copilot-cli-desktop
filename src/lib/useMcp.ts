import { useCallback, useEffect, useRef, useState } from 'react';

import { explain } from './errors';
import { mcpLogin, mcpStatus, removeMcpServer, saveMcpServer, setMcpEnabled } from './sidecar';
import type { McpServerConfig, McpServerState } from '../../shared/protocol';

/**
 * The MCP servers: what they are doing, and changing what they are.
 *
 * Status is null until it has been asked, and null for a session that is not loaded - which
 * is not a failure but the usual case. No session is ever resumed to answer: connection
 * state is something a reader would like to see rather than something they asked for, and
 * starting a process for that is the thing this app exists to avoid (#24).
 *
 * Read when the panel opens, and again whenever the runtime says a server changed. The
 * events are the only reason this is worth holding rather than fetching once: a server that
 * is still connecting answers `pending` and would stay that way on screen for ever.
 *
 * The four ways to change one share a shape, because the runtime owns the config file and
 * the disabled list rather than this app: there is nothing here to update optimistically,
 * so each one does the thing and then reads the panel again. That reread is the only
 * account of what took.
 *
 * @param sessionId  whose servers to report on, or null for no session.
 * @param reload     reads the environment panel again; holds its own failures.
 * @param report     where to say what went wrong, cleared before each attempt.
 * @param openPage   opens a sign-in page in the browser.
 */
export function useMcp(
  sessionId: string | null,
  reload: () => Promise<void>,
  report: (message: string | null) => void,
  openPage: (url: string) => Promise<unknown>,
) {
  const [status, setStatus] = useState<McpServerState[] | null>(null);
  /** Which server's form the panel is showing, so `/mcp add` and `/mcp edit` can open one. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Which session the held answer describes, so a slow reply cannot land on another. */
  const showing = useRef(sessionId);
  showing.current = sessionId;

  /**
   * The callers are held rather than depended on.
   *
   * `reload` changes identity with the working directory and `report` with whatever holds
   * the error line. Depending on either would rebuild every action below whenever the
   * session changed, for callbacks whose behaviour does not vary with it.
   */
  const given = useRef({ reload, report, openPage });
  given.current = { reload, report, openPage };

  const reread = useCallback(() => {
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
    reread();
  }, [sessionId, reread]);

  /** Do it, then read the panel again, and say so rather than failing silently. */
  const attempt = useCallback(async (change: () => Promise<void>) => {
    given.current.report(null);
    try {
      await change();
      await given.current.reload();
    } catch (error: unknown) {
      given.current.report(explain(error));
    }
  }, []);

  const toggle = useCallback(
    (name: string, enabled: boolean) => attempt(() => setMcpEnabled(name, enabled)),
    [attempt],
  );

  // Neither writing a server down nor taking one away costs a session: a server is
  // configuration, not conversation (#24).
  const save = useCallback(
    (name: string, config: McpServerConfig) => attempt(() => saveMcpServer(name, config)),
    [attempt],
  );

  const remove = useCallback((name: string) => attempt(() => removeMcpServer(name)), [attempt]);

  /**
   * Begin signing in to a server that is waiting for it.
   *
   * Unlike reading the status, this may resume the session: pressing a button is somebody
   * asking, which is the case the rule allows a resume for. The runtime holds the other end
   * of the exchange and says how it went through an event, so there is nothing to wait on
   * here beyond opening the page.
   */
  const signIn = useCallback(async (session: string, name: string) => {
    given.current.report(null);
    try {
      const url = await mcpLogin(session, name);
      if (url) await given.current.openPage(url);
      else given.current.report(`${name} did not ask for a sign-in page.`);
    } catch (error: unknown) {
      given.current.report(explain(error));
    }
  }, []);

  return { status, reread, editing, edit: setEditing, toggle, save, remove, signIn };
}
