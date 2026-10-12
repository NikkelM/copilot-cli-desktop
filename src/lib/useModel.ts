import { useCallback, useEffect, useRef, useState } from 'react';

import { explain } from './errors';
import { listModels, sessionAutoTier, sessionModel, setSessionModel } from './sidecar';
import type {
  AutoTier,
  ContextTier,
  ModelChoice,
  ReasoningEffort,
  SessionAutoTier,
  SessionModel,
  TranscriptEvent,
} from '../../shared/protocol';

/** Fetched once per run: the catalogue does not change while the app is open. */
let asking: Promise<ModelChoice[]> | null = null;

/**
 * Where the catalogue is kept between runs.
 *
 * Listing models costs a server process, which is the one thing this app will not spend on
 * something nobody asked for. But a session's log names its model without saying how large
 * that model's context is, so without a remembered catalogue the header could not say how
 * much room a session has until the reader opened the picker. The list changes rarely, and
 * is refreshed the moment they do open it.
 */
const REMEMBERED = 'copilot-desktop.models';

/**
 * A remembered entry is only usable if it still matches what this version expects.
 *
 * What is stored outlives the code that stored it: an entry written before the catalogue
 * carried context sizes has no `contexts` on it, and reading one crashed the header. Shape
 * is checked rather than versioned so that any future change is caught the same way.
 */
function usable(value: unknown): value is ModelChoice {
  const model = value as ModelChoice | null;
  return (
    typeof model?.id === 'string' &&
    typeof model.name === 'string' &&
    Array.isArray(model.reasoningEfforts) &&
    Array.isArray(model.contexts)
  );
}

function remembered(): ModelChoice[] | null {
  try {
    const stored = localStorage.getItem(REMEMBERED);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(usable) ? (parsed as ModelChoice[]) : null;
  } catch {
    // A corrupt or unreadable entry is worth no more than an absent one.
    return null;
  }
}

/**
 * What a session runs on, the means to change it, and the catalogue to change it from.
 *
 * The current model is read from the session's log rather than from the runtime, so a
 * session that is not loaded can still say what it runs on. Changing it does cost a resume,
 * because the choice belongs to the running session; that is the same price as sending.
 */
export function useModel(sessionId: string | null, onError: (message: string) => void) {
  /** Undefined until the log has been read: not yet known is not the same as none. */
  const [current, setCurrent] = useState<SessionModel | null | undefined>(undefined);
  const [models, setModels] = useState<ModelChoice[] | null>(remembered);
  const [failed, setFailed] = useState<string | null>(null);
  /**
   * How `auto` routes, which only a loaded session can say (#215).
   *
   * Null covers both "not loaded" and "never asked", because the picker does the same thing
   * with either: it offers the preferences without claiming one is in force.
   */
  const [autoTier, setAutoTier] = useState<SessionAutoTier | null>(null);

  const showing = useRef(sessionId);
  showing.current = sessionId;
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    setCurrent(undefined);
    if (!sessionId) return;

    sessionModel(sessionId)
      .then((found) => showing.current === sessionId && setCurrent(found))
      .catch(() => showing.current === sessionId && setCurrent(null));
  }, [sessionId]);

  /** Ask the session itself how it routes, which answers only while it is loaded. */
  const readTier = useCallback((forSession: string) => {
    sessionAutoTier(forSession)
      .then((found) => showing.current === forSession && setAutoTier(found))
      // A session that is not loaded answers null, so a thrown error is something else
      // entirely - and the picker without a tier is the same picker it was before this.
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setAutoTier(null);
    if (sessionId) readTier(sessionId);
  }, [sessionId, readTier]);

  /**
   * Follow a change the runtime reports.
   *
   * Every resume emits one of these as well as every switch, so this keeps the header
   * right when a session is woken, and when it is changed from a terminal.
   */
  const observe = useCallback(
    (event: TranscriptEvent) => {
      /*
       * A routing preference that never took.
       *
       * Ephemeral, so it is the only notice there will be: the runtime commits a tier on a
       * later turn that uses `auto`, and this is what it says when that turn could not get a
       * model out of the preference. Said plainly rather than left as a picker quietly
       * showing a pending mark for ever.
       */
      if (event.type === 'session.auto_tier_switch_failed') {
        const why = (event.data as { reason?: unknown } | undefined)?.reason;
        report.current(
          why === 'policy_rejected'
            ? 'That routing preference was refused by model policy.'
            : 'That routing preference could not be applied.',
        );
        setAutoTier((held) => (held ? { ...held, pending: undefined } : held));
        return;
      }

      if (event.type !== 'session.model_change') return;

      // A delegated run announces the model it was given the same way the session does. Taking
      // it for the session's own is what moved the header to a small model, and the context it
      // reports down with it, for as long as that run lasted.
      if (event.agentId) return;

      // The turn that commits a pending tier reports itself as a model change, so this is
      // where one stops pending. Asked again rather than assumed: what the runtime settled on
      // is its answer to give, not ours to infer from having requested it.
      if (showing.current) readTier(showing.current);

      const data = (event.data ?? {}) as { newModel?: string; reasoningEffort?: string; contextTier?: string };
      if (data.newModel) {
        setCurrent({ model: data.newModel, reasoningEffort: data.reasoningEffort, contextTier: data.contextTier });
      }
    },
    [readTier],
  );

  const choose = useCallback(
    (choice: {
      model: string;
      reasoningEffort?: ReasoningEffort;
      contextTier?: ContextTier;
      autoTier?: AutoTier | null;
    }) => {
      const forSession = showing.current;
      if (!forSession) return;

      // Shown as chosen at once: switching resumes the session, which takes seconds, and
      // the runtime's own event replaces this when it arrives.
      setCurrent({ model: choice.model, reasoningEffort: choice.reasoningEffort, contextTier: choice.contextTier });

      /*
       * The routing preference is the one thing here that is not shown as done.
       *
       * Every other choice in this menu takes effect on the next message. This one the
       * runtime only records: it commits on a later turn that uses `auto`, once that turn
       * gets a usable model out of it, and it can fail at that point. So it is marked as
       * asked for, and stays marked until the runtime says otherwise.
       */
      if (choice.autoTier !== undefined) {
        setAutoTier((held) => ({ ...(held ?? {}), pending: choice.autoTier ?? null }));
      }

      setSessionModel(forSession, choice.model, choice.reasoningEffort, choice.contextTier, choice.autoTier).catch(
        (e: unknown) => report.current(explain(e)),
      );
    },
    [],
  );

  /** Ask the runtime what is available, which is what starting the shared server is for. */
  const refresh = useCallback(() => {
    setFailed(null);
    (asking ??= listModels())
      .then((found) => {
        setModels(found);
        try {
          localStorage.setItem(REMEMBERED, JSON.stringify(found));
        } catch {
          // Remembering is an optimisation; failing to is not worth reporting.
        }
      })
      .catch((e: unknown) => {
        asking = null; // So a failure can be retried rather than remembered forever.
        setFailed(explain(e));
      });
  }, []);

  return { current, autoTier, models, failed, observe, choose, refresh };
}
