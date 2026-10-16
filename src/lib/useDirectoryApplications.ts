import { useCallback, useEffect, useState } from 'react';

import type { DirectoryApplication } from '../../shared/directoryApplications';
import { directoryApplications, openDirectory } from './sidecar';
import { messageOf } from './errors';

export function useDirectoryApplications(custom: string, target: string, onError: (message: string) => void) {
  const [applications, setApplications] = useState<DirectoryApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void directoryApplications(custom).then(
      (apps) => { if (live) setApplications(apps); },
      (error: unknown) => { if (live) setError(messageOf(error)); },
    ).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [custom]);

  const open = useCallback((cwd: string) => {
    void openDirectory(cwd, target, custom).catch((error: unknown) => onError(messageOf(error)));
  }, [target, custom, onError]);

  return { applications, loading, error, open };
}
