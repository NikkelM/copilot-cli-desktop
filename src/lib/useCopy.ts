import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the confirmation stays up. Long enough to read, short enough not to linger. */
const CONFIRM_MS = 1200;

/**
 * Copying, and saying that it happened.
 *
 * The clipboard gives no feedback of its own, so a button that copies silently is a button
 * nobody trusts: they press it twice and check somewhere else. The state is held rather
 * than animated away, so the same hook can say so wherever the button is drawn.
 */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A confirmation still counting down when the row is gone would set state on nothing.
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = useCallback((text: string) => {
    const settle = (ok: boolean) => {
      setCopied(ok);
      setFailed(!ok);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
        setFailed(false);
      }, CONFIRM_MS);
    };

    navigator.clipboard
      .writeText(text)
      .then(() => settle(true))
      // Saying nothing would look the same as succeeding, which is the one thing worse
      // than failing.
      .catch(() => settle(false));
  }, []);

  return { copied, failed, copy };
}
