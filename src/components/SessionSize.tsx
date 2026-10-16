import { useEffect, useRef, useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';

import type { SessionDiskDetails } from '../../shared/protocol';
import { singleSessionDiskUsage } from '../lib/sidecar';
import { messageOf } from '../lib/errors';
import { bytes } from '../lib/units';
import { useFocusTrap } from '../lib/useFocusTrap';

export function SessionSize({
  sessionId,
  title,
  onClose,
  onOpenSession,
}: {
  sessionId: string;
  title: string | null;
  onClose: () => void;
  onOpenSession?: () => void;
}) {
  const [size, setSize] = useState<SessionDiskDetails | null>(null);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useFocusTrap(box);

  useEffect(() => {
    let live = true;
    setReading(true);
    setSize(null);
    setError(null);
    void singleSessionDiskUsage(sessionId).then(
      (size) => {
        if (live) {
          setSize(size);
          setReading(false);
        }
      },
      (error: unknown) => {
        if (live) {
          setError(messageOf(error));
          setReading(false);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => close.current?.focus(), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm"
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Session disk usage"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-title">Session disk usage</h2>
        <div className="confirm-body">
          <p>{title ?? 'Untitled session'}</p>
          {error && <p role="alert" className="error">{error}</p>}
          {(!error || size) && (
            <p role="status">{reading ? 'Measuring...' : size ? bytes(size.bytes) : null}</p>
          )}
          {size && (
            <dl className="session-size-breakdown">
              <dt>Conversation log</dt><dd>{bytes(size.logBytes)}</dd>
              <dt>Rewind backups</dt><dd>{bytes(size.rewindBytes)}</dd>
              <dt>Other files</dt><dd>{bytes(size.otherBytes)}</dd>
              <dt>File count</dt><dd>{size.files.toLocaleString()}</dd>
            </dl>
          )}
        </div>
        <div className="confirm-actions session-size-actions">
          <button
            type="button"
            className="confirm-cancel"
            disabled={!size}
            onClick={() => {
              if (size) void openPath(size.directory).catch((error: unknown) => setError(messageOf(error)));
            }}
          >
            Open session folder
          </button>
          {onOpenSession && (
            <button type="button" className="confirm-cancel" onClick={onOpenSession}>
              Open session
            </button>
          )}
          <button type="button" ref={close} className="confirm-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
