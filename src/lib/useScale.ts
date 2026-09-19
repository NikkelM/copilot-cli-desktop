import { useCallback, useEffect, useState } from 'react';

import { STEP, SCALE_KEY, applyScale, clampScale, readScale } from './scale';
import { save } from './store';

/**
 * The scale everything is drawn at, applied at once and remembered for next time.
 *
 * Live rather than at next launch, which is the only way to choose a size: it is picked by
 * looking at the result, and a restart between each press would make that guesswork (#139).
 */
export function useScale() {
  const [scale, setScale] = useState(readScale);

  // On every change including the first, so a remembered scale is in force before anything
  // is drawn at the default and then jumps.
  useEffect(() => {
    applyScale(scale);
    save('settings', SCALE_KEY, String(scale));
  }, [scale]);

  const larger = useCallback(() => setScale((current) => clampScale(current + STEP)), []);
  const smaller = useCallback(() => setScale((current) => clampScale(current - STEP)), []);
  /** Back to the app's own size, for a reader who has lost track of where they are. */
  const reset = useCallback(() => setScale(1), []);

  return { scale, larger, smaller, reset };
}
