import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';

import { isPreviewable, nameOf } from '../lib/paths';
import { previewImage } from '../lib/sidecar';
import { type Attachment } from '../../shared/protocol';
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
 *
 * A name is a poor way to identify a picture, so pointing at an image or reaching it with
 * the keyboard shows it. Clicking any chip reveals the file in its folder rather than
 * opening it, which would hand it to whatever application claims the extension - rarely
 * what was wanted, and not undoable.
 */
export function Attachments({
  attached,
  onChange,
  onPicker,
  onFocusBack,
  onError,
}: {
  attached: Attachment[];
  /** Absent where the files have been sent and are a record rather than a choice (#111). */
  onChange?: (attached: Attachment[]) => void;
  /** Hands the composer a way to open the picker, since the button is up there. */
  onPicker?: (pick: () => void) => void;
  /** Called when the picker is done with, either way: the keyboard belongs back in the box. */
  onFocusBack?: () => void;
  onError: (message: string) => void;
}) {
  /**
   * The chip whose picture is up, and where to put it.
   *
   * Held here rather than in each chip so only one preview can be open, and so a preview
   * cannot outlive the chip that opened it.
   */
  const [showing, setShowing] = useState<{ path: string; top: number; left: number } | null>(null);
  /** Bytes already fetched, so moving along a row of chips asks the sidecar once each. */
  const [previews, setPreviews] = useState<Record<string, string | null>>({});

  useEffect(() => {
    // Nothing to offer a picker to where the files have already been sent.
    if (!onPicker || !onChange) return;

    onPicker(() => {
      open({ multiple: true, title: 'Attach files' })
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
        .finally(() => onFocusBack?.());
    });
  }, [attached, onChange, onPicker, onFocusBack, onError]);

  if (attached.length === 0) return null;

  /**
   * Show a chip's picture, whether it was pointed at or reached with the keyboard.
   *
   * A name is a poor way to identify a picture, which is the whole reason this exists - and
   * that is no less true for somebody who never touches the mouse. Bound to hover alone, the
   * picture was the one thing in the app a keyboard could not get to at all.
   */
  const show = (file: Attachment, chip: HTMLElement) => {
    if (!isPreviewable(file.path)) return;

    const box = chip.getBoundingClientRect();
    // Anchored to the chip's top edge: the composer sits at the bottom of the window, so a
    // preview below it would be off the screen.
    setShowing({ path: file.path, top: box.top, left: box.left });

    if (!(file.path in previews)) {
      previewImage(file.path)
        .catch(() => null)
        .then((dataUrl) => setPreviews((current) => ({ ...current, [file.path]: dataUrl })));
    }
  };

  return (
    <div className="attachments">
      {attached.map((file) => (
        <span className="attachment" key={file.path}>
          <button
            type="button"
            className="attachment-name"
            title={`Show ${file.path} in its folder`}
            onClick={() => revealItemInDir(file.path).catch((e: unknown) => onError(String(e)))}
            onMouseEnter={(event) => show(file, event.currentTarget)}
            onMouseLeave={() => setShowing(null)}
            onFocus={(event) => show(file, event.currentTarget)}
            onBlur={() => setShowing(null)}
          >
            {file.displayName ?? file.path}
          </button>
          {/* Absent once the message has gone: what it carried is a record by then, and a
              cross beside it would offer to change something that has already happened. */}
          {onChange && (
            <button
              type="button"
              // A cross beside the words is not somewhere to be: taking the file off should
              // leave the caret where it was, mid-sentence, rather than moving it out of the
              // box and back. Pressing a button focuses it first, and this is what stops
              // that happening - the click still arrives.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(attached.filter((other) => other.path !== file.path));
                // For the reader who got here by tabbing: the chip goes with the file, and
                // focus would go with the chip.
                onFocusBack?.();
              }}
              aria-label={`Remove ${file.displayName ?? file.path}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {showing && previews[showing.path] && (
        <img
          className="attachment-preview"
          style={{ top: showing.top, left: showing.left }}
          src={previews[showing.path] ?? undefined}
          alt={nameOf(showing.path)}
        />
      )}
    </div>
  );
}
