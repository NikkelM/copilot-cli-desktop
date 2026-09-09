import type { TranscriptEvent } from '../../shared/protocol';

/**
 * The prompts already sent in a session, newest first.
 *
 * Every terminal has this and the app had nothing, which makes resending a message mean
 * retyping it. Taken from the transcript rather than kept alongside it, so it is there for
 * a session opened for the first time as well as one written in this run - and so it cannot
 * drift from what was actually sent.
 *
 * The transcript is paged, so this covers the prompts that have been loaded rather than
 * every prompt ever. That is the right span: history is for what was just said, and loading
 * a session's entire past to fill it would undo the reason the transcript is paged at all.
 */
export function promptHistory(events: readonly TranscriptEvent[]): string[] {
  const prompts: string[] = [];

  for (const event of events) {
    if (event.type !== 'user.message') continue;

    const content = (event.data as { content?: unknown } | null)?.content;
    if (typeof content !== 'string') continue;

    const prompt = content.trim();
    if (!prompt) continue;

    // The same message sent twice in a row is one entry: stepping back through a repeated
    // prompt to reach the one before it is the behaviour every shell drops for a reason.
    if (prompts[prompts.length - 1] === prompt) continue;
    prompts.push(prompt);
  }

  return prompts.reverse();
}
