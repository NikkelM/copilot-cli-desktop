/**
 * Requests handed to the user that the agent is blocked on.
 *
 * Permissions and elicitations both hand a promise to the agent and wait for an answer,
 * and both must be settled on every path that tears a session down. Getting that wrong
 * leaves the agent blocked forever, which has happened once already, so the rule lives
 * in one place rather than being reimplemented per request type.
 */
export class PendingRequests<T> {
  private readonly entries = new Map<string, { sessionId: string; resolve: (value: T) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;

  /**
   * @param prefix distinguishes ids between registries
   * @param timeoutMs how long to wait before giving up on the user
   * @param onTimeout the value to settle with when nobody answers
   */
  constructor(
    private readonly prefix: string,
    private readonly timeoutMs: number,
    private readonly onTimeout: () => T,
  ) {}

  /** Register a request and return its id along with the promise the agent waits on. */
  add(sessionId: string): { requestId: string; answered: Promise<T> } {
    const requestId = `${this.prefix}-${this.nextId++}`;

    const answered = new Promise<T>((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, this.onTimeout()), this.timeoutMs);
      timer.unref(); // Never keep the process alive purely to expire a prompt.
      this.entries.set(requestId, { sessionId, resolve, timer });
    });

    return { requestId, answered };
  }

  /** Answer a request. Ignored if it was already settled, so a double answer is harmless. */
  settle(requestId: string, value: T): string | null {
    const entry = this.entries.get(requestId);
    if (!entry) return null;

    clearTimeout(entry.timer);
    this.entries.delete(requestId);
    entry.resolve(value);
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

  /** Apply a value to every outstanding request for a session, e.g. when policy changes. */
  ids(sessionId: string): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([requestId]) => requestId);
  }
}
