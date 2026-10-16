import { useState } from 'react';

import type { usePlan } from '../lib/usePlan';
import { Confirm } from './Confirm';
import { WikiPageBody } from './WikiPageBody';

const RECOVERED_PLAN = { path: 'plan.md' };

export function SessionPlan({ plan: state, onClose }: { plan: ReturnType<typeof usePlan>; onClose: () => void }) {
  const [preview, setPreview] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const dirty = !!state.draft && state.draft.content !== state.plan?.content;
  const canSave = dirty && !state.conflict && !state.loading && !state.saving;

  return (
    <aside
      className="notes"
      aria-label="Session plan"
      data-region="panel"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !discarding) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          event.stopPropagation();
          if (canSave) void state.save();
        }
      }}
    >
      <header className="notes-head">
        <span className="notes-title" title={state.plan?.path}>Plan</span>
        <span className="notes-actions">
          {state.draft ? (
            <>
              <button type="button" className="changes-action" aria-pressed={preview} onClick={() => setPreview(!preview)}>
                {preview ? 'Source' : 'Preview'}
              </button>
              <button type="button" className="changes-action primary" disabled={!canSave} onClick={() => void state.save()}>
                {state.saving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                className="changes-action"
                disabled={state.saving}
                onClick={() => {
                  if (dirty) setDiscarding(true);
                  else state.discard();
                }}
              >
                Discard edits
              </button>
            </>
          ) : (
            <button
              type="button"
              className="changes-action"
              disabled={!state.plan || state.loading}
              onClick={() => {
                setPreview(false);
                state.edit();
              }}
            >
              Edit
            </button>
          )}
          <button type="button" className="changes-action" disabled={state.loading || state.saving} onClick={() => void state.refresh()}>
            Reload
          </button>
          <button type="button" className="notes-close" aria-label="Close plan" onClick={onClose}>&times;</button>
        </span>
      </header>
      {state.failed && <p className="error" role="alert">{state.failed}</p>}
      {state.notificationFailed && (
        <div>
          <p className="error" role="alert">{state.notificationFailed}</p>
          <button type="button" className="changes-action" disabled={state.saving} onClick={() => void state.retryNotification()}>
            Retry notification
          </button>
        </div>
      )}
      {state.notifying && <p className="changes-note" role="status">Notifying agent...</p>}
      {state.conflict && <p className="error" role="alert">The plan changed on disk. Your draft is preserved. Copy any edits you want to keep before discarding it to load the latest plan.</p>}
      {state.draft && <p className="changes-note">Draft kept locally until saved, including when you close this panel or switch sessions. Saving also notifies the agent and resumes this session if needed.</p>}
      <div className="notes-body">
        <WikiPageBody
          page={state.plan ?? (state.draft ? RECOVERED_PLAN : null)}
          source={state.draft?.content ?? state.plan?.content ?? ''}
          raw={!!state.draft && !preview}
          loading={state.loading}
          onEdit={(_path, source) => state.change(source)}
          sourceLabel="Plan Markdown"
          disabled={state.saving}
          empty="This session has no plan file."
        />
      </div>
      {discarding && (
        <Confirm
          title="Discard plan edits?"
          body="Your local draft will be removed. The plan on disk will not change."
          confirmLabel="Discard edits"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            state.discard();
            setDiscarding(false);
          }}
        />
      )}
    </aside>
  );
}
