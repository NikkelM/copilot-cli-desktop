import { useCallback, useMemo, useRef, useState } from 'react';

import type {
  ElicitationAction,
  ElicitationFieldValue,
  PendingElicitation,
  PendingPermission,
  PermissionChoice,
} from '../../shared/protocol';

import {
  onElicitationRequested,
  onElicitationResolved,
  onPermissionRequested,
  onPermissionResolved,
  resolveElicitation,
  resolvePermission,
} from './sidecar';
import { explain } from './errors';
import { useTauriEvent } from './useTauriEvent';

/**
 * The questions an agent is blocked on: permission requests and elicitations.
 *
 * Both halves of the app need these and want different things from them. The sidebar wants
 * every session's, to mark the ones waiting on someone; the pane wants only the open
 * session's, to draw the prompt. Kept together because they share one invariant - a request
 * is shown exactly until it is settled, and settling it twice is a protocol error the
 * runtime answers with a rejection.
 */
export function usePrompts(sessionId: string | null, onError: (message: string) => void) {
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [elicitations, setElicitations] = useState<PendingElicitation[]>([]);

  const report = useRef(onError);
  report.current = onError;

  /**
   * The requests not yet settled, mirrored where it can be read and written synchronously.
   *
   * State cannot arbitrate this. Two answers in the same tick both see the list as it was
   * before either of them, so both would send, and the runtime rejects a second answer to
   * a request that is already settled. The realistic way in is not a double click - the
   * prompt unmounts - but a request resolved from elsewhere, or expiring, while a click is
   * already on its way. Bounded by the same thing the lists are: an id is added when the
   * request arrives and removed the moment it is settled.
   */
  const open = useRef(new Set<string>());

  /** Take ownership of settling a request, or report that someone already has. */
  const claim = useCallback((requestId: string) => open.current.delete(requestId), []);

  useTauriEvent(() =>
    onPermissionRequested((pending) => {
      open.current.add(pending.requestId);
      setPermissions((current) =>
        // Guard against the same request arriving twice.
        current.some((p) => p.requestId === pending.requestId) ? current : [...current, pending],
      );
    }),
  );

  useTauriEvent(() =>
    onPermissionResolved(({ requestId }) => {
      open.current.delete(requestId);
      setPermissions((current) => current.filter((p) => p.requestId !== requestId));
    }),
  );

  useTauriEvent(() =>
    onElicitationRequested((pending) => {
      open.current.add(pending.requestId);
      setElicitations((current) =>
        current.some((e) => e.requestId === pending.requestId) ? current : [...current, pending],
      );
    }),
  );

  useTauriEvent(() =>
    onElicitationResolved(({ requestId }) => {
      open.current.delete(requestId);
      setElicitations((current) => current.filter((e) => e.requestId !== requestId));
    }),
  );

  const answerPermission = useCallback(
    (pending: PendingPermission, choice: PermissionChoice) => {
      // Dropped before the call rather than on its reply, so the prompt cannot be answered
      // twice by a second click while the first is still in flight.
      setPermissions((current) => current.filter((p) => p.requestId !== pending.requestId));
      if (!claim(pending.requestId)) return;
      void resolvePermission(pending.sessionId, pending.requestId, choice).catch((e: unknown) =>
        report.current(explain(e)),
      );
    },
    [claim],
  );

  const answerElicitation = useCallback(
    (
      pending: PendingElicitation,
      action: ElicitationAction,
      content?: Record<string, ElicitationFieldValue>,
    ) => {
      setElicitations((current) => current.filter((e) => e.requestId !== pending.requestId));
      if (!claim(pending.requestId)) return;
      void resolveElicitation(pending.requestId, action, content).catch((e: unknown) =>
        report.current(explain(e)),
      );
    },
    [claim],
  );

  /**
   * Forget everything, for when the sidecar goes.
   *
   * Nothing is answered on the way out: the runtime that asked is gone, so there is nobody
   * left to tell. Leaving the prompts up would offer buttons that cannot do anything.
   */
  const clear = useCallback(() => {
    open.current.clear();
    setPermissions([]);
    setElicitations([]);
  }, []);

  const mine = useMemo(
    () => ({
      permissions: permissions.filter((p) => p.sessionId === sessionId),
      elicitations: elicitations.filter((e) => e.sessionId === sessionId),
    }),
    [permissions, elicitations, sessionId],
  );

  return {
    permissions,
    elicitations,
    mine,
    answerPermission,
    answerElicitation,
    clear,
    /** Whether the session on screen is waiting on an answer, which the composer stands down for. */
    blocked: mine.permissions.length + mine.elicitations.length > 0,
  };
}
