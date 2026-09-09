import { MAX_PASTE_BYTES, type Attachment } from '../../shared/protocol';
import { nameOf } from './paths';
import { stashPaste } from './sidecar';

export interface Stashed {
  attached: Attachment[];
  /** Files that were past the limit, named so the message can say which. */
  tooLarge: string[];
}

/**
 * Turn pasted files into attachments.
 *
 * A message carries paths, and the clipboard carries bytes: a screenshot exists nowhere
 * until something writes it out. The sidecar does the writing, beside the session's own
 * record, so this only has to get the bytes across.
 *
 * Files past the limit are reported rather than thrown, so pasting a folder where one
 * item is oversized still attaches the rest.
 */
export async function stashFiles(sessionId: string, files: readonly File[]): Promise<Stashed> {
  const attached: Attachment[] = [];
  const tooLarge: string[] = [];

  for (const file of files) {
    // Checked before reading: encoding a file only to be told it is too big would freeze
    // the box being typed in for as long as the read takes.
    if (file.size > MAX_PASTE_BYTES) {
      tooLarge.push(file.name || 'the pasted file');
      continue;
    }

    const path = await stashPaste({ sessionId, name: file.name || 'paste', data: await encode(file) });
    attached.push({ type: 'file', path, displayName: nameOf(path) });
  }

  return { attached, tooLarge };
}

/**
 * The file's bytes as base64.
 *
 * Through a data URL rather than a loop over the bytes: the encoder is the browser's own,
 * and building the string by hand overflows the stack on anything the size of a screenshot.
 */
function encode(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the pasted file'}`));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
