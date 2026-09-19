import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionEnvironment } from '../../shared/protocol';
import { explain } from './errors';
import { describeEnvironment } from './sidecar';

/**
 * What a session would load, asked for only when someone wants to know.
 *
 * No session is resumed to answer, but the first ask does start the shared server if
 * nothing else has, so it waits to be asked rather than happening on every selection. The
 * same bargain the agent list makes.
 *
 * Nothing is cached between asks. The whole use of this panel is checking what is in force
 * after editing an instructions file or turning a plugin off, and a remembered answer would
 * be confidently wrong exactly when it is being consulted.
 */
export function useEnvironment(cwd: string | null) {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /** Which ask the answer on its way belongs to, so a late one cannot overwrite a newer. */
  const asked = useRef(0);

  // Another directory loads different instructions, so holding the last one's says something
  // false about this one.
  useEffect(() => {
    asked.current += 1;
    setEnvironment(null);
    setFailed(null);
    setLoading(false);
  }, [cwd]);

  const load = useCallback(() => {
    asked.current += 1;
    const ask = asked.current;

    setLoading(true);
    setFailed(null);

    return describeEnvironment(cwd ?? undefined)
      .then((result) => {
        if (ask === asked.current) setEnvironment(result);
      })
      .catch((error: unknown) => {
        if (ask === asked.current) setFailed(explain(error));
      })
      .finally(() => {
        if (ask === asked.current) setLoading(false);
      });
  }, [cwd]);

  return { environment, loading, failed, load };
}
