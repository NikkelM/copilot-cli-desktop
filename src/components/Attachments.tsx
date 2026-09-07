import { useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

import type { Attachment } from '../../shared/protocol';

/**
 * Files riding along with the next message.
 *
 * The composer took text and nothing else, so attaching a screenshot meant saving it
 * somewhere and describing the path in words. The runtime has taken attachments all along;
 * it was this app that had no way to say so.
 *
 * Shown before sending, and removable: picking the wrong file should not mean sending it.
 * The button that opens the picker lives with the other buttons rather than here, so a
 * message with several files attached grows upwards instead of pushing Send off the line.
 */
export function Attachments({
  attached,
  onChange,
  onPicker,
  onFocusBack,
  onError,
}: {
  attached: Attachment[];
  onChange: (attached: Attachment[]) => void;
  /** Hands the composer a way to open the picker, since the button is up there. */
  onPicker: (pick: () => void) => void;
  /** Called when the picker is done with, either way: the keyboard belongs back in the box. */
  onFocusBack: () => void;
  onError: (message: string) => void;
}) {
  useEffect(() => {
    onPicker(() => {
      open({ multiple: true, title: 'Attach to this message' })
        .then((picked) => {
          if (picked) {
            const paths = Array.isArray(picked) ? picked : [picked];
            // Picking the same file twice says nothing the first pick did not.
            const fresh = paths
              .filter((path) => !attached.some((file) => file.path === path))
              .map((path): Attachment => ({ type: 'file', path, displayName: nameOf(path) }));

            onChange([...attached, ...fresh]);
          }
        })
        .catch((e: unknown) => onError(String(e)))
        // Whether they picked something or thought better of it, they are back at the
        // message they were writing.
        .finally(onFocusBack);
    });
  }, [attached, onChange, onPicker, onFocusBack, onError]);

  if (attached.length === 0) return null;

  return (
    <div className="attachments">
      {attached.map((file) => (
        <span className="attachment" key={file.path} title={file.path}>
          {file.displayName ?? file.path}
          <button
            type="button"
            onClick={() => onChange(attached.filter((other) => other.path !== file.path))}
            aria-label={`Remove ${file.displayName ?? file.path}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/** The last part of a path, whichever way its separators lean. */
function nameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
