import { useCallback, useEffect, useState, type RefObject } from 'react';

import { messageOf } from './errors';
import { staleRuntime } from './protocolCheck';
import { onSidecarBehind, rebuildSidecar } from './sidecarFreshness';
import { onSidecarRestarted, onSidecarStopped, restartRuntime } from './sidecar';
import { useTauriEvent } from './useTauriEvent';

interface RuntimeHealth {
  /** Why nothing works, or null while it does. Outranks every other message on screen. */
  stopped: string | null;
  /** Why the runtime is a version behind the code on disk, or null. Development only. */
  behind: string | null;
  /** Whether a rebuild is under way, so it cannot be asked for twice. */
  rebuilding: boolean;
  /** Build the sidecar again and start a replacement from it. */
  rebuild: () => void;
  /** Put the version-behind notice away, for a reader who has read it. */
  dismiss: () => void;
}

/**
 * Whether the runtime answering this window is there, and whether it is the right one.
 *
 * Four questions that read as one - gone, built from a different protocol, behind the
 * source, being replaced - and they were four flags in App with their subscriptions spread
 * between them. Two of them arrived together (#169) and made the fifth and sixth pieces of
 * state in a component that had sixteen, which is what #87 says to act on.
 *
 * Deliberately not the app's error sink. `setError` is passed to seven hooks and carries
 * whatever a request failed at; these say the runtime itself cannot be relied on, which is
 * a different claim and is shown in a different place.
 *
 * @param onLost   the runtime has gone: whatever was waiting on it never will be answered
 * @param onReplaced a new one is up, and knows nothing the old one was told
 */
export function useRuntimeHealth(
  onLost: () => void,
  onReplaced: () => void,
  expectedStop?: RefObject<boolean>,
): RuntimeHealth {
  const [stopped, setStopped] = useState<string | null>(null);
  const [behind, setBehind] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  /**
   * Refuse a runtime built from a different protocol, loudly, before it is used (#169).
   *
   * Shown the same way as a sidecar that has gone away, because it has the same shape: the
   * reader cannot fix it from in here, everything below it is untrustworthy, and the one
   * useful action is to restart. Left to itself it surfaces later as a single feature
   * failing for reasons that are nothing to do with that feature.
   */
  const checkProtocol = useCallback(() => {
    void staleRuntime().then((message) => message && setStopped(message));
  }, []);

  useEffect(checkProtocol, [checkProtocol]);

  // The dev server watches the files the sidecar was built from; the sidecar cannot.
  useEffect(() => onSidecarBehind(setBehind), []);

  // Losing the sidecar takes every session with it, and a request that will never be
  // answered otherwise shows as the app quietly doing nothing.
  useTauriEvent(
    () =>
      onSidecarStopped((reason) => {
        if (!expectedStop?.current) setStopped(reason);
        onLost();
      }),
    [expectedStop, onLost],
  );

  // A replacement is up. Nothing it was told survives, so whatever was concluded about the
  // last one says nothing about this one - on a dev machine it is often a different build.
  useTauriEvent(
    () =>
      onSidecarRestarted(() => {
        setStopped(null);
        setBehind(null);
        checkProtocol();
        onReplaced();
      }),
    [checkProtocol, onReplaced],
  );

  /**
   * Build the sidecar again, then start a replacement from what was built.
   *
   * The failure is kept rather than cleared. A rebuild that did not work and one that did
   * must not look the same, or the restart afterwards loads the old code and tells the
   * reader the problem is dealt with.
   */
  const rebuild = useCallback(() => {
    setRebuilding(true);
    rebuildSidecar()
      .then(() => restartRuntime())
      .catch((error: unknown) => setBehind(messageOf(error)))
      .finally(() => setRebuilding(false));
  }, []);

  const dismiss = useCallback(() => setBehind(null), []);

  return { stopped, behind, rebuilding, rebuild, dismiss };
}
