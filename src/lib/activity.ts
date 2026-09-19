import type { PendingElicitation, PendingPermission, PendingPlanApproval } from '../../shared/protocol';

/**
 * What a session is doing, for the one row that has to say it (#115).
 *
 * A single value rather than a set of flags, because the row has one indicator and the
 * reader has one question: does this need me. Ordered by how much it asks of them, so
 * combining two states is a matter of taking the larger.
 */
export type Activity = 'idle' | 'loading' | 'queued' | 'working' | 'blocked';

/** Ascending by what it asks of the reader, which is what makes `Math.max` the right merge. */
const RANK: Record<Activity, number> = { idle: 0, loading: 1, queued: 2, working: 3, blocked: 4 };

export interface ActivityMark {
  state: Activity;
  /** Messages waiting behind the current turn, which explain a delay rather than cause one. */
  queued: number;
}

/**
 * Anything an agent is blocked on, of which only the session it belongs to matters here.
 *
 * Permissions, questions and plans are three different asks with three different prompts,
 * but the sidebar says the same thing about all of them, so they arrive as one list rather
 * than as a parameter per kind that grows every time another is added.
 */
export type Blocking = Pick<PendingPermission | PendingElicitation | PendingPlanApproval, 'sessionId'>;

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
  blocked: readonly Blocking[],
  queued: Readonly<Record<string, number>>,
  loading: ReadonlySet<string> = new Set(),
): Record<string, ActivityMark> {
  const marks: Record<string, ActivityMark> = {};

  const raise = (sessionId: string, state: Activity) => {
    const held = marks[sessionId] ?? { state: 'idle', queued: 0 };
    marks[sessionId] = { ...held, state: RANK[state] > RANK[held.state] ? state : held.state };
  };

  // Lowest of the four, so anything the session turns out to be doing wins: a resume that
  // has already produced a question is answering it, not still arriving.
  for (const sessionId of loading) raise(sessionId, 'loading');
  for (const sessionId of working) raise(sessionId, 'working');
  for (const pending of blocked) raise(pending.sessionId, 'blocked');

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
    case 'loading':
      return 'Coming into memory';
    default:
      return 'Loaded in memory';
  }
}
