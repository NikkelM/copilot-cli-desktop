import { useCallback, useEffect, useRef, useState } from 'react';

import { listModels, sessionModel, setSessionModel } from './sidecar';
import type {
  ContextTier,
  ModelChoice,
  ReasoningEffort,
  SessionModel,
  TranscriptEvent,
} from '../../shared/protocol';

/** Fetched once per run: the catalogue does not change while the app is open. */
let catalogue: Promise<ModelChoice[]> | null = null;

/**
 * What a session runs on, and the means to change it.
 *
 * The current model is read from the session's log rather than from the runtime, so a
 * session that is not loaded can still say what it runs on. Changing it does cost a resume,
 * because the choice belongs to the running session; that is the same price as sending.
 */
export function useModel(sessionId: string | null, onError: (message: string) => void) {
  const [current, setCurrent] = useState<SessionModel | null>(null);

  const showing = useRef(sessionId);
  showing.current = sessionId;
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    setCurrent(null);
    if (!sessionId) return;

    sessionModel(sessionId)
      .then((found) => showing.current === sessionId && setCurrent(found))
      .catch(() => undefined);
  }, [sessionId]);

  /**
   * Follow a change the runtime reports.
   *
   * Every resume emits one of these as well as every switch, so this keeps the header
   * right when a session is woken, and when it is changed from a terminal.
   */
  const observe = useCallback((event: TranscriptEvent) => {
    if (event.type !== 'session.model_change') return;

    const data = (event.data ?? {}) as { newModel?: string; reasoningEffort?: string };
    if (data.newModel) setCurrent({ model: data.newModel, reasoningEffort: data.reasoningEffort });
  }, []);

  const choose = useCallback((choice: { model: string; reasoningEffort?: ReasoningEffort; contextTier?: ContextTier }) => {
    const forSession = showing.current;
    if (!forSession) return;

    // Shown as chosen at once: switching resumes the session, which takes seconds, and the
    // runtime's own event replaces this when it arrives.
    setCurrent({ model: choice.model, reasoningEffort: choice.reasoningEffort, contextTier: choice.contextTier });
    setSessionModel(forSession, choice.model, choice.reasoningEffort, choice.contextTier).catch((e: unknown) =>
      report.current(String(e)),
    );
  }, []);

  return {
    current,
    observe,
    choose,
    models: useCallback(() => (catalogue ??= listModels()), []),
  };
}
