import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionMode, TranscriptEvent } from '../../shared/protocol';

import { sessionMode, setSessionMode } from './sidecar';
import { explain } from './errors';

/**
 * The order Alt+M walks, matching the CLI and the SDK's own declaration order.
 *
 * Interactive first because it is where a session starts and where most work happens, and
 * autopilot last because it is the one that stops asking.
 */
export const MODE_ORDER: readonly SessionMode[] = ['interactive', 'plan', 'autopilot'];

/** What each mode is called and does, for the indicator and its tooltip. */
export const MODE_LABELS: Record<SessionMode, { label: string; hint: string }> = {
  interactive: { label: 'interactive', hint: 'Asks before anything consequential' },
  plan: { label: 'plan', hint: 'Writes a plan and waits for approval' },
  autopilot: { label: 'autopilot', hint: 'Works without asking for approval' },
};

/**
 * How a session is working, and the means to change it.
 *
 * Read from the log when the session is cold, so asking costs no Copilot process; changing
 * it does cost a resume, because a mode belongs to the running session. That is the same
 * price as sending, and unlike reading it is something the reader asked for outright.
 */
export function useMode(sessionId: string | null, onError: (message: string) => void) {
  // A session that has never said otherwise is interactive, so there is no "not yet known"
  // state to model here: the default is the answer until something contradicts it.
  const [mode, setMode] = useState<SessionMode>('interactive');

  const showing = useRef(sessionId);
  showing.current = sessionId;
  const report = useRef(onError);
  report.current = onError;

  /**
   * Counts the answers that outrank the log, so a slow read cannot undo one.
   *
   * The log is read when a session is opened, and a resume emits a mode change while that
   * read is still in flight - so the stale answer lands last and puts the indicator back to
   * whatever the log happened to say. Anything the runtime reports, or the reader chooses,
   * bumps this, and a read whose count has moved on is dropped.
   */
  const settled = useRef(0);

  useEffect(() => {
    setMode('interactive');
    if (!sessionId) return;

    const asOf = settled.current;
    sessionMode(sessionId)
      .then((found) => {
        if (showing.current === sessionId && settled.current === asOf) setMode(found);
      })
      .catch(() => {
        // The default is already showing, and a session that cannot say what mode it is in
        // is not worth interrupting the reader over.
      });
  }, [sessionId]);

  /**
   * Follow a change the runtime reports.
   *
   * Which covers the two ways a mode changes without this app asking: a slash command that
   * reports one, and a terminal attached to the same session.
   */
  const observe = useCallback((event: TranscriptEvent) => {
    if (event.type !== 'session.mode_changed') return;

    const next = (event.data as { newMode?: string } | undefined)?.newMode;
    if (!MODE_ORDER.includes(next as SessionMode)) return;

    settled.current++;
    setMode(next as SessionMode);
  }, []);

  const choose = useCallback((next: SessionMode) => {
    const forSession = showing.current;
    if (!forSession) return;

    // Shown at once, because switching resumes the session and that takes seconds. The
    // runtime's answer replaces this, so a switch that was refused corrects itself rather
    // than leaving the reader looking at a mode the session is not in.
    settled.current++;
    setMode(next);
    setSessionMode(forSession, next)
      .then((result) => {
        if (showing.current !== forSession) return;
        settled.current++;
        setMode(result.mode);
        // Entering plan mode can change the model, which is worth saying out loud.
        if (result.notice) report.current(result.notice);
      })
      .catch((e: unknown) => report.current(explain(e)));
  }, []);

  /** Advance to the next mode, which the CLI asks for with Shift+Tab and this app with Alt+M. */
  const cycle = useCallback(() => {
    const at = MODE_ORDER.indexOf(mode);
    choose(MODE_ORDER[(at + 1) % MODE_ORDER.length]!);
  }, [mode, choose]);

  return { mode, observe, choose, cycle };
}
