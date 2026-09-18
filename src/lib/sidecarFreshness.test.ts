import { describe, expect, it, vi } from 'vitest';

import {
  SIDECAR_BEHIND_EVENT,
  SIDECAR_REBUILD_EVENT,
  SIDECAR_REBUILT_EVENT,
  affectsRunningSidecar,
  behindMessage,
  onSidecarBehind,
  rebuildSidecar,
} from './sidecarFreshness';

const repo = 'F:/Users/nikke/Projects/copilot-cli-desktop';

describe('which edits leave the running sidecar behind', () => {
  it('counts the sidecar own sources', () => {
    expect(affectsRunningSidecar(`${repo}/sidecar/src/git.ts`)).toBe(true);
  });

  /**
   * The case `PROTOCOL_VERSION` cannot see. Both halves compile this separately, the
   * frontend picks up an edit at once, and a changed parameter shape does not move the
   * method-name fingerprint at all.
   */
  it('counts the protocol the two halves share', () => {
    expect(affectsRunningSidecar(`${repo}/shared/protocol.ts`)).toBe(true);
  });

  it('reads a Windows path the watcher reports', () => {
    expect(affectsRunningSidecar('F:\\Users\\nikke\\Projects\\ccd\\sidecar\\src\\git.ts')).toBe(true);
  });

  // The window replaces these itself, which is the whole difference being drawn here.
  it('ignores the frontend, which hot-reloads', () => {
    expect(affectsRunningSidecar(`${repo}/src/lib/useRepoStatus.ts`)).toBe(false);
  });

  it('ignores a frontend component', () => {
    expect(affectsRunningSidecar(`${repo}/src/components/Repository.tsx`)).toBe(false);
  });

  // A suite in watch mode would otherwise call the app stale on every save.
  it('ignores a sidecar test', () => {
    expect(affectsRunningSidecar(`${repo}/sidecar/src/git.test.ts`)).toBe(false);
  });

  it('ignores a shared test', () => {
    expect(affectsRunningSidecar(`${repo}/shared/protocol.test.ts`)).toBe(false);
  });

  it('ignores what the sidecar never imports', () => {
    expect(affectsRunningSidecar(`${repo}/sidecar/src/notes.md`)).toBe(false);
    expect(affectsRunningSidecar(`${repo}/src/App.css`)).toBe(false);
  });

  it('ignores the Rust shell, which restarts the sidecar by restarting itself', () => {
    expect(affectsRunningSidecar(`${repo}/src-tauri/src/lib.rs`)).toBe(false);
  });
});

describe('what it says about it', () => {
  it('names the file that moved', () => {
    expect(behindMessage(`${repo}/sidecar/src/git.ts`)).toContain('src/git.ts');
  });

  it('says what to do about it', () => {
    expect(behindMessage(`${repo}/sidecar/src/git.ts`)).toContain('version behind');
  });

  /**
   * The mistake this whole thing exists to stop: a message that names a feature sends the
   * reader into that feature's source, which is correct, which is where the time goes.
   */
  it('blames the build rather than whatever is about to misbehave', () => {
    expect(behindMessage(`${repo}/shared/protocol.ts`)).toMatch(/runtime is a version behind/i);
  });

  it('reads a Windows path the same way', () => {
    expect(behindMessage('F:\\ccd\\sidecar\\src\\git.ts')).toContain('src/git.ts');
  });
});

describe('hearing it from the dev server', () => {
  /** Vite's HMR client, reduced to the two calls this uses. */
  const channel = () => {
    let listener: ((data: unknown) => void) | undefined;
    return {
      on: vi.fn((_: string, fn: (data: unknown) => void) => {
        listener = fn;
      }),
      off: vi.fn(),
      send: (data: unknown) => listener?.(data),
    };
  };

  it('listens for the event the dev server sends', () => {
    const hot = channel();

    onSidecarBehind(() => {}, hot);

    expect(hot.on).toHaveBeenCalledWith(SIDECAR_BEHIND_EVENT, expect.any(Function));
  });

  it('reports the file the dev server named', () => {
    const hot = channel();
    const heard = vi.fn();

    onSidecarBehind(heard, hot);
    hot.send({ file: `${repo}/sidecar/src/git.ts` });

    expect(heard).toHaveBeenCalledWith(behindMessage(`${repo}/sidecar/src/git.ts`));
  });

  it('ignores a message with no file in it', () => {
    const hot = channel();
    const heard = vi.fn();

    onSidecarBehind(heard, hot);
    hot.send({});
    hot.send({ file: 42 });
    hot.send(null);

    expect(heard).not.toHaveBeenCalled();
  });

  it('stops listening when asked', () => {
    const hot = channel();

    onSidecarBehind(() => {}, hot)();

    expect(hot.off).toHaveBeenCalledWith(SIDECAR_BEHIND_EVENT, expect.any(Function));
  });

  it('takes back the same listener it registered', () => {
    const hot = channel();

    onSidecarBehind(() => {}, hot)();

    expect(hot.off.mock.calls[0]?.[1]).toBe(hot.on.mock.calls[0]?.[1]);
  });

  /** A packaged app has no dev server, and a sidecar that was built alongside it. */
  it('does nothing at all without a dev server', () => {
    expect(() => onSidecarBehind(() => {}, undefined)()).not.toThrow();
  });
});

describe('asking the dev server to rebuild it', () => {
  const channel = () => {
    const listeners = new Map<string, (data: unknown) => void>();
    return {
      on: vi.fn((event: string, fn: (data: unknown) => void) => void listeners.set(event, fn)),
      off: vi.fn((event: string) => void listeners.delete(event)),
      send: vi.fn(),
      reply: (data: unknown) => listeners.get(SIDECAR_REBUILT_EVENT)?.(data),
      listening: () => listeners.has(SIDECAR_REBUILT_EVENT),
    };
  };

  it('asks', () => {
    const hot = channel();

    void rebuildSidecar(hot);

    expect(hot.send).toHaveBeenCalledWith(SIDECAR_REBUILD_EVENT);
  });

  it('settles once the dev server says it is done', async () => {
    const hot = channel();
    const waiting = rebuildSidecar(hot);

    hot.reply({ error: null });

    await expect(waiting).resolves.toBeUndefined();
  });

  /**
   * The failure that must not be quiet: restarting after a rebuild that did not happen
   * loads the same code again, and the reader is back where they started having been told
   * the problem was dealt with.
   */
  it('fails with what the build said', async () => {
    const hot = channel();
    const waiting = rebuildSidecar(hot);

    hot.reply({ error: 'TS2339: Property does not exist' });

    await expect(waiting).rejects.toThrow(/TS2339/);
  });

  it('waits rather than settling before the answer comes', async () => {
    const hot = channel();
    const settled = vi.fn();

    void rebuildSidecar(hot).then(settled, settled);
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
  });

  it('stops listening once it has an answer', async () => {
    const hot = channel();
    const waiting = rebuildSidecar(hot);

    hot.reply({ error: null });
    await waiting;

    expect(hot.listening()).toBe(false);
  });

  it('stops listening after a failure too', async () => {
    const hot = channel();
    const waiting = rebuildSidecar(hot);

    hot.reply({ error: 'nope' });
    await expect(waiting).rejects.toThrow();

    expect(hot.listening()).toBe(false);
  });

  it('refuses when there is no dev server to ask', async () => {
    await expect(rebuildSidecar(undefined)).rejects.toThrow(/no dev server/i);
  });
});
