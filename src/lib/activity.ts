import type { PendingElicitation, PendingPermission } from '../../shared/protocol';

/**
 * What a session is doing, for the one row that has to say it (#115).
 *
 * A single value rather than a set of flags, because the row has one indicator and the
 * reader has one question: does this need me. Ordered by how much it asks of them, so
 * combining two states is a matter of taking the larger.
 */
export type Activity = 'idle' | 'queued' | 'working' | 'blocked';

/** Ascending by what it asks of the reader, which is what makes `Math.max` the right merge. */
const RANK: Record<Activity, number> = { idle: 0, queued: 1, working: 2, blocked: 3 };

export interface ActivityMark {
  state: Activity;
  /** Messages waiting behind the current turn, which explain a delay rather than cause one. */
  queued: number;
}

/**
 * Fold everything the app knows about what sessions are doing into one entry per session.
 *
 * The pieces live apart for good reasons - the runtime reports turns, the app holds the
 * prompts it has not answered, the queue is the app's own - and only the sidebar needs them
 * together. Doing the join here keeps that from becoming three props and three merges in
 * the row.
 */
export function activityOf(
  working: ReadonlySet<string>,
  permissions: readonly PendingPermission[],
  elicitations: readonly PendingElicitation[],
  queued: Readonly<Record<string, number>>,
): Record<string, ActivityMark> {
  const marks: Record<string, ActivityMark> = {};

  const raise = (sessionId: string, state: Activity) => {
    const held = marks[sessionId] ?? { state: 'idle', queued: 0 };
    marks[sessionId] = { ...held, state: RANK[state] > RANK[held.state] ? state : held.state };
  };

  for (const sessionId of working) raise(sessionId, 'working');
  for (const pending of permissions) raise(pending.sessionId, 'blocked');
  for (const pending of elicitations) raise(pending.sessionId, 'blocked');

  for (const [sessionId, count] of Object.entries(queued)) {
    if (count <= 0) continue;
    raise(sessionId, 'queued');
    marks[sessionId] = { ...marks[sessionId]!, queued: count };
  }

  return marks;
}

/** What the indicator says when hovered, and what a reader is told it means. */
export function describeActivity({ state, queued }: ActivityMark): string {
  const waiting = queued === 1 ? '1 message waiting' : `${queued} messages waiting`;

  switch (state) {
    case 'blocked':
      return `Waiting on a decision. The agent is blocked until it is answered${queued ? `. ${waiting}` : ''}`;
    case 'working':
      return `Working${queued ? `. ${waiting}` : ''}`;
    case 'queued':
      return waiting;
    default:
      return 'Loaded in memory';
  }
}
