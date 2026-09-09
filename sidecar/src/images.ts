import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import { MAX_PREVIEW_BYTES, PREVIEWABLE } from '../../shared/protocol.js';

/**
 * An image as a data URL, or null if there is nothing worth showing.
 *
 * The webview cannot read `file://`, and giving it a scope wide enough to cover an
 * attachment would mean giving it most of the disk - an attachment is wherever the reader
 * picked it from. So the bytes come through here instead, where the path is already known
 * and a single file is all that is handed over.
 *
 * Every failure returns null rather than throwing: a preview that does not appear is the
 * whole cost of getting this wrong, and a hover is not a place to report errors.
 */
export function previewImage(path: string): string | null {
  const mime = PREVIEWABLE[extname(path).toLowerCase()];
  if (!mime) return null;

  try {
    // Checked before reading, so an enormous file is never held in memory to be rejected.
    if (statSync(path).size > MAX_PREVIEW_BYTES) return null;

    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}
