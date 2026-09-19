import { useCallback, useEffect, useRef, useState } from 'react';

import { explain } from './errors';
import { listModels, sessionModel, setSessionModel } from './sidecar';
import type {
  ContextTier,
  ModelChoice,
  ReasoningEffort,
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

  /**
   * Follow a change the runtime reports.
   *
   * Every resume emits one of these as well as every switch, so this keeps the header
   * right when a session is woken, and when it is changed from a terminal.
   */
  const observe = useCallback((event: TranscriptEvent) => {
    if (event.type !== 'session.model_change') return;

    const data = (event.data ?? {}) as { newModel?: string; reasoningEffort?: string; contextTier?: string };
    if (data.newModel) {
      setCurrent({ model: data.newModel, reasoningEffort: data.reasoningEffort, contextTier: data.contextTier });
    }
  }, []);

  const choose = useCallback(
    (choice: { model: string; reasoningEffort?: ReasoningEffort; contextTier?: ContextTier }) => {
      const forSession = showing.current;
      if (!forSession) return;

      // Shown as chosen at once: switching resumes the session, which takes seconds, and
      // the runtime's own event replaces this when it arrives.
      setCurrent({ model: choice.model, reasoningEffort: choice.reasoningEffort, contextTier: choice.contextTier });
      setSessionModel(forSession, choice.model, choice.reasoningEffort, choice.contextTier).catch((e: unknown) =>
        report.current(explain(e)),
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

  return { current, models, failed, observe, choose, refresh };
}
