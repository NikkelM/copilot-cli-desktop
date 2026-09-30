import { useCallback, useEffect, useState } from 'react';

/**
 * The tall panels that open under a transcript, of which one shows at a time.
 *
 * `changes` is what the agent edited, `repository` is the working tree including the
 * reader's own edits, `todos` is what the agent says it is doing, and `environment` is what
 * the session can reach. Deliberately separate things rather than one, since acting on one
 * must never be mistaken for acting on another.
 */
export type Panel = 'changes' | 'environment' | 'repository' | 'todos';

/**
 * Which panel is open, as one answer rather than one flag each.
 *
 * Three booleans could say that two panels were open, which the app has always meant to be
 * impossible - they are tall, and stacking them pushes the transcript off the screen. Saying
 * it in one value makes it impossible rather than merely intended: every open closes
 * whatever was open before, because there is only one place to write the answer.
 *
 * As three flags it was intended and half-implemented. Opening the repository closed the
 * other two, but opening either of those left the repository where it was, so `/git`
 * followed by the Changes button showed both (#87).
 */
export function usePanel(sessionId: string | null) {
  const [open, setOpen] = useState<Panel | null>(null);

  /**
   * A panel describes the session it was opened on, so moving to another closes it.
   *
   * One rule rather than one effect per panel, which is the other thing three flags cost:
   * a fourth panel would have needed somebody to remember this, and the one that was added
   * last is exactly the one that would be forgotten.
   */
  useEffect(() => setOpen(null), [sessionId]);

  const show = useCallback((panel: Panel) => setOpen(panel), []);
  const hide = useCallback(() => setOpen(null), []);

  return { open, show, hide };
}
