import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionPlan } from '../../shared/protocol';
import { onSessionEvent, onSidecarRestarted, saveSessionPlan, sendMessage, sessionPlan, watchSessionPlan } from './sidecar';
import { read, save } from './store';
import { useTauriEvent } from './useTauriEvent';

interface PlanDraft {
  content: string;
  revision: string;
}

const DRAFTS = 'sessionPlanDrafts';
const NOTICES = 'sessionPlanNotices';

interface PlanNotice {
  path: string;
  prompt: string;
}

function readNotices(): Record<string, PlanNotice> {
  try {
    const value: unknown = JSON.parse(read('sessions', NOTICES) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, PlanNotice] => {
      const notice: unknown = entry[1];
      return !!notice && typeof notice === 'object'
        && 'path' in notice && typeof notice.path === 'string'
        && 'prompt' in notice && typeof notice.prompt === 'string';
    }));
  } catch (error) {
    console.error('Could not read pending plan notifications', error);
    return {};
  }
}

function planNotice(path: string, sections?: string): string {
  const instruction = sections
    ? `Changed: ${sections}. Reread those sections and any needed context`
    : 'Reread it';
  return `The user edited \`${path}\`. ${instruction} before continuing, adapt remaining work, and preserve their edits.`;
}

function readDrafts(): Record<string, PlanDraft> {
  try {
    const value: unknown = JSON.parse(read('sessions', DRAFTS) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, PlanDraft] => {
      const draft: unknown = entry[1];
      return !!draft && typeof draft === 'object'
        && 'content' in draft && typeof draft.content === 'string'
        && 'revision' in draft && typeof draft.revision === 'string';
    }));
  } catch (error) {
    console.error('Could not read saved plan drafts', error);
    return {};
  }
}

export function usePlan(sessionId: string | null) {
  const [found, setFound] = useState<{ sessionId: string; plan: SessionPlan | null } | null>(null);
  const [drafts, setDrafts] = useState(readDrafts);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [watchFailures, setWatchFailures] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notifyingId, setNotifyingId] = useState<string | null>(null);
  const [notices, setNotices] = useState(readNotices);
  const [noticeErrors, setNoticeErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(false);
  const [loading, setLoading] = useState(false);
  const [watchGeneration, setWatchGeneration] = useState(0);
  const selected = useRef(sessionId);
  selected.current = sessionId;
  const generation = useRef(0);

  useEffect(() => save('sessions', DRAFTS, JSON.stringify(drafts)), [drafts]);
  useEffect(() => save('sessions', NOTICES, JSON.stringify(notices)), [notices]);

  const notify = useCallback(async (id: string, notice: PlanNotice) => {
    setNotifyingId(id);
    setNoticeErrors((current) => ({ ...current, [id]: '' }));
    try {
      await sendMessage({ sessionId: id, prompt: notice.prompt, mode: 'immediate' });
      setNotices((current) => {
        if (current[id]?.prompt !== notice.prompt) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch (error) {
      setNoticeErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setNotifyingId(null);
    }
  }, []);

  const fail = useCallback((id: string, error: unknown) => {
    setFailures((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }));
  }, []);

  const refresh = useCallback(async () => {
    const id = selected.current;
    const ticket = ++generation.current;
    if (!id) return;
    setLoading(true);
    try {
      const plan = await sessionPlan(id);
      if (selected.current !== id || ticket !== generation.current) return;
      setFound({ sessionId: id, plan });
      setFailures((current) => ({ ...current, [id]: '' }));
    } catch (error) {
      if (selected.current === id && ticket === generation.current) fail(id, error);
    } finally {
      if (selected.current === id && ticket === generation.current) setLoading(false);
    }
  }, [fail]);

  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useTauriEvent(() => onSidecarRestarted(() => setWatchGeneration((current) => current + 1)));
  useTauriEvent(() => onSessionEvent(({ sessionId: id, event }) => {
    if (id !== selected.current || !['session.plan_changed', 'session.plan_file_changed'].includes(event.type)) return;
    const data = event.data;
    if (data && typeof data === 'object' && 'failed' in data && typeof data.failed === 'string') {
      const failed = data.failed;
      setWatchFailures((current) => ({ ...current, [id]: failed }));
      return;
    }
    clearTimeout(settling.current);
    settling.current = setTimeout(() => void refresh(), 150);
  }), [refresh, fail]);

  useEffect(() => {
    let live = true;
    ++generation.current;
    setLoading(!!sessionId);
    void watchSessionPlan(sessionId)
      .then(() => {
        if (live && sessionId) setWatchFailures((current) => ({ ...current, [sessionId]: '' }));
      })
      .catch((error: unknown) => {
        if (live && sessionId) setWatchFailures((current) => ({ ...current, [sessionId]: String(error) }));
      })
      .then(() => {
        if (live) void refresh();
      });
    return () => {
      live = false;
      ++generation.current;
      clearTimeout(settling.current);
      void watchSessionPlan(null).catch((error: unknown) => console.error('Could not stop watching the session plan', error));
    };
  }, [sessionId, refresh, fail, watchGeneration]);

  const plan = found?.sessionId === sessionId ? found.plan : null;
  const draft = sessionId ? drafts[sessionId] : undefined;
  const edit = () => {
    if (!sessionId || !plan || draft) return;
    setDrafts((current) => ({ ...current, [sessionId]: { content: plan.content, revision: plan.revision } }));
  };
  const change = (content: string) => {
    if (!sessionId || !draft) return;
    setDrafts((current) => ({ ...current, [sessionId]: { ...draft, content } }));
  };
  const discard = () => {
    if (!sessionId) return;
    setDrafts((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  };
  const store = async () => {
    if (!sessionId || !draft || inFlight.current || draft.content === plan?.content) return;
    const id = sessionId;
    inFlight.current = true;
    ++generation.current;
    setSavingId(id);
    setLoading(false);
    try {
      const saved = await saveSessionPlan(id, draft.content, draft.revision);
      if (selected.current === id) {
        ++generation.current;
        setFound({ sessionId: id, plan: saved });
        setLoading(false);
      }
      setFailures((current) => ({ ...current, [id]: '' }));
      setDrafts((current) => {
        const next = { ...current };
        if (next[id]?.content === draft.content) delete next[id];
        else if (next[id]) next[id] = { ...next[id], revision: saved.revision };
        return next;
      });
      // An earlier undelivered edit needs a full reread, not just this save's locations
      const notice = { path: saved.path, prompt: planNotice(saved.path, notices[id] ? undefined : saved.changedSections) };
      setNotices((current) => ({ ...current, [id]: notice }));
      await notify(id, notice);
    } catch (error) {
      fail(id, error);
    } finally {
      inFlight.current = false;
      setSavingId(null);
    }
  };

  const retryNotification = async () => {
    const id = sessionId;
    const pending = id ? notices[id] : undefined;
    if (!id || !pending || inFlight.current) return;
    inFlight.current = true;
    try {
      // Locations can move before a retry, so ask for the current whole plan
      const notice = { path: pending.path, prompt: planNotice(pending.path) };
      setNotices((current) => ({ ...current, [id]: notice }));
      await notify(id, notice);
    } finally {
      inFlight.current = false;
    }
  };
  const notificationFailed = sessionId && notices[sessionId] && notifyingId !== sessionId
    ? `The plan is saved, but the agent has not been notified.${noticeErrors[sessionId] ? ` ${noticeErrors[sessionId]}` : ''}`
    : undefined;

  return {
    plan, draft, loading, failed: sessionId ? failures[sessionId] || watchFailures[sessionId] : undefined,
    saving: savingId !== null || notifyingId !== null,
    notifying: notifyingId === sessionId && sessionId !== null,
    notificationFailed,
    conflict: !!draft && !loading && (!plan || plan.revision !== draft.revision),
    edit, change, discard, save: store, refresh, retryNotification,
  };
}
