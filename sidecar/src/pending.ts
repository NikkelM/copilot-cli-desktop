/**
 * Requests handed to the user that the agent is blocked on.
 *
 * Permissions and elicitations both hand a promise to the agent and wait for an answer,
 * and both must be settled on every path that tears a session down. Getting that wrong
 * leaves the agent blocked forever, which has happened once already, so the rule lives
 * in one place rather than being reimplemented per request type.
 */
export class PendingRequests<T> {
  private readonly entries = new Map<string, { sessionId: string; resolve: (value: T) => void; timer?: NodeJS.Timeout }>();
  private nextId = 1;

  get size(): number {
    return this.entries.size;
  }

  /**
   * @param prefix distinguishes ids between registries
   * @param timeoutMs how long to wait before giving up on the user, asked each time
   * @param onTimeout the value to settle with when nobody answers
   * @param onSettled told whenever a request stops waiting, however it stopped
   *
   * The wait is asked for rather than given, because it is a setting: a reader who
   * lengthens it while something is already waiting has said what they want to happen to
   * the next question, and a registry holding the old number would answer the one after
   * that as well.
   *
   * `onSettled` lives here rather than at each call site because one path settles from
   * inside this class - giving up on the user - and a caller cannot announce what it did
   * not do. Announcing it per call site meant that path announced nothing, and the UI went
   * on offering a prompt whose answer had nowhere left to go.
   */
  constructor(
    private readonly prefix: string,
    private readonly timeoutMs: () => number,
    private readonly onTimeout: () => T,
    private readonly onSettled?: (sessionId: string, requestId: string) => void,
  ) {}

  /**
   * Register a request and return its id along with the promise the agent waits on.
   *
   * `expiresAt` comes back because a blocked agent is the one wait that ends badly if it
   * is not noticed, and only this class knows when it lapses. Reported rather than kept:
   * the timer is authoritative, this is what to tell the reader about it. Null when the
   * wait is off, since there is then nothing to count down to.
   */
  add(sessionId: string): { requestId: string; expiresAt: string | null; answered: Promise<T> } {
    const requestId = `${this.prefix}-${this.nextId++}`;
    const waitFor = this.timeoutMs();
    const expiresAt = waitFor > 0 ? new Date(Date.now() + waitFor).toISOString() : null;

    const answered = new Promise<T>((resolve) => {
      // No timer at all rather than a very long one: waiting for ever is a real answer for
      // somebody who would rather come back to a question than to a decision made for them.
      const timer = waitFor > 0 ? setTimeout(() => this.settle(requestId, this.onTimeout()), waitFor) : undefined;
      timer?.unref(); // Never keep the process alive purely to expire a prompt.
      this.entries.set(requestId, { sessionId, resolve, timer });
    });

    return { requestId, expiresAt, answered };
  }

  /** Answer a request. Ignored if it was already settled, so a double answer is harmless. */
  settle(requestId: string, value: T): string | null {
    const entry = this.entries.get(requestId);
    if (!entry) return null;

    clearTimeout(entry.timer);
    this.entries.delete(requestId);
    entry.resolve(value);
    this.onSettled?.(entry.sessionId, requestId);
    return entry.sessionId;
  }

  /** Settle everything belonging to a session, so tearing it down cannot leave it blocked. */
  abandon(sessionId: string, value: T): string[] {
    const settled: string[] = [];

    for (const [requestId, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue;
      this.settle(requestId, value);
      settled.push(requestId);
    }

    return settled;
  }
}
