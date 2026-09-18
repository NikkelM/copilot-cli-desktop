import { useCallback, useMemo, useRef, useState } from 'react';

import type {
  ElicitationAction,
  ElicitationFieldValue,
  PendingElicitation,
  PendingPermission,
  PendingPlanApproval,
  PermissionChoice,
  PlanAction,
} from '../../shared/protocol';

import {
  onElicitationRequested,
  onElicitationResolved,
  onPermissionRequested,
  onPermissionResolved,
  onPlanRequested,
  onPlanResolved,
  resolveElicitation,
  resolvePermission,
  resolvePlan,
} from './sidecar';
import { explain } from './errors';
import { useTauriEvent } from './useTauriEvent';

/**
 * The questions an agent is blocked on: permission requests, elicitations and plans.
 *
 * All three want the same thing from this hook and want it in both halves of the app. The
 * sidebar wants every session's, to mark the ones waiting on someone; the pane wants only
 * the open session's, to draw the prompt. Kept together because they share one invariant -
 * a request is shown exactly until it is settled, and settling it twice is a protocol error
 * the runtime answers with a rejection.
 */
export function usePrompts(sessionId: string | null, onError: (message: string) => void) {
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [elicitations, setElicitations] = useState<PendingElicitation[]>([]);
  const [plans, setPlans] = useState<PendingPlanApproval[]>([]);

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

  useTauriEvent(() =>
    onPlanRequested((pending) => {
      open.current.add(pending.requestId);
      setPlans((current) =>
        current.some((p) => p.requestId === pending.requestId) ? current : [...current, pending],
      );
    }),
  );

  useTauriEvent(() =>
    onPlanResolved(({ requestId }) => {
      open.current.delete(requestId);
      setPlans((current) => current.filter((p) => p.requestId !== requestId));
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
   * Approve a plan, or turn it down with feedback the agent can plan against again.
   *
   * A plan the reader never chose an action for is still approved: the agent asked two
   * things at once, and only the approval is compulsory.
   */
  const answerPlan = useCallback(
    (pending: PendingPlanApproval, approved: boolean, selectedAction?: PlanAction, feedback?: string) => {
      setPlans((current) => current.filter((p) => p.requestId !== pending.requestId));
      if (!claim(pending.requestId)) return;
      void resolvePlan(pending.requestId, approved, selectedAction, feedback).catch((e: unknown) =>
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
    setPlans([]);
  }, []);

  const mine = useMemo(
    () => ({
      permissions: permissions.filter((p) => p.sessionId === sessionId),
      elicitations: elicitations.filter((e) => e.sessionId === sessionId),
      plans: plans.filter((p) => p.sessionId === sessionId),
    }),
    [permissions, elicitations, plans, sessionId],
  );

  /**
   * Every ask that has an agent stopped, whatever kind it is and whichever session it is in.
   *
   * Named here rather than assembled where it is used. A permission, a question and a plan
   * are three different prompts, but "the agent is stopped until somebody answers" is one
   * fact about all three, and a caller that had to remember to include each of them could
   * quietly leave one out: the sidebar would then go on saying a session was idle while it
   * sat waiting on a question (#187).
   */
  const blocking = useMemo(
    () => [...permissions, ...elicitations, ...plans],
    [permissions, elicitations, plans],
  );

  return {
    permissions,
    elicitations,
    plans,
    blocking,
    mine,
    answerPermission,
    answerElicitation,
    answerPlan,
    clear,
    /** Whether the session on screen is waiting on an answer, which the composer stands down for. */
    blocked: mine.permissions.length + mine.elicitations.length + mine.plans.length > 0,
  };
}
