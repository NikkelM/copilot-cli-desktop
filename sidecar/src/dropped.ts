import { statSync } from 'node:fs';

import type { Dropped } from '../../shared/protocol.js';

/**
 * Sort dropped paths into what can be attached and what cannot (#231).
 *
 * The window is handed paths by the webview and has no way to tell a file from a folder:
 * it cannot read the disk, deliberately - the sidecar owns that, which is why a preview
 * comes through here rather than over `file://`.
 *
 * Asked rather than assumed, because dropping a folder is an easy thing to do by accident
 * and attaching one as though it were a file would send the runtime something it cannot
 * open. Saying which is which costs one `stat` each and lets the drop explain itself.
 */
export function classifyDropped(paths: string[]): Dropped {
  const dropped: Dropped = { files: [], folders: [], missing: [] };

  for (const path of paths) {
    try {
      // Follows a link rather than describing it: what was dropped is what it points at.
      const found = statSync(path);
      if (found.isDirectory()) dropped.folders.push(path);
      else dropped.files.push(path);
    } catch {
      dropped.missing.push(path);
    }
  }

  return dropped;
}
