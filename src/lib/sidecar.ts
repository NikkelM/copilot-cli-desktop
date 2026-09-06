import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type {
  ElicitationAction,
  ElicitationFieldValue,
  ElicitationResolvedNotification,
  GetTranscriptResult,
  ListSessionsResult,
  PendingElicitation,
  PendingPermission,
  PermissionChoice,
  PermissionResolvedNotification,
  RuntimeStatus,
  SendParams,
  SendResult,
  SessionChangesResult,
  SessionEventNotification,
  SessionLoadedNotification,
} from '../../shared/protocol';

/** Single entry point for every sidecar call, so transport details stay in one place. */
async function request<T>(method: string, params?: unknown): Promise<T> {
  return invoke<T>('sidecar_request', { method, params: params ?? null });
}

/** Reads the sidebar model from session-store.db. Spawns no Copilot process. */
export function listSessions(): Promise<ListSessionsResult> {
  return request<ListSessionsResult>('sessions.list');
}

/** Replays a session transcript from events.jsonl without resuming it. */
export function getTranscript(
  sessionId: string,
  limit?: number,
  before?: number,
): Promise<GetTranscriptResult> {
  return request<GetTranscriptResult>('sessions.transcript', { sessionId, limit, before });
}

export function getRuntimeStatus(): Promise<RuntimeStatus> {
  return request<RuntimeStatus>('runtime.status');
}

/** What the agent has changed since the current turn began. Costs a couple of git calls. */
export function getChanges(sessionId: string): Promise<SessionChangesResult> {
  return request<SessionChangesResult>('sessions.changes', { sessionId });
}

/** The patch for one changed file. Fetched only when a file is opened. */
export function getDiff(sessionId: string, path: string): Promise<{ patch: string }> {
  return request<{ patch: string }>('sessions.diff', { sessionId, path });
}

/** Resumes the session if it is cold, then sends. This is the only call that costs memory. */
export function sendMessage(params: SendParams): Promise<SendResult> {
  return request<SendResult>('sessions.send', params);
}

export function abortSession(sessionId: string): Promise<void> {
  return request<void>('sessions.abort', { sessionId });
}

export function evictSession(sessionId: string): Promise<void> {
  return request<void>('sessions.evict', { sessionId });
}

export function setApprovalPolicy(sessionId: string, policy: 'prompt' | 'approve-all'): Promise<void> {
  return request<void>('sessions.setApprovalPolicy', { sessionId, policy });
}

/** Answer a pending tool permission request, unblocking the agent. */
export function resolvePermission(
  sessionId: string,
  requestId: string,
  choice: PermissionChoice,
): Promise<void> {
  return request<void>('sessions.resolvePermission', { sessionId, requestId, choice });
}

/** Live session events forwarded from the sidecar. */
export function onSessionEvent(handler: (payload: SessionEventNotification) => void) {
  return listen<SessionEventNotification>('session-event', (e) => handler(e.payload));
}

/** Notifies when a session is resumed into, or released from, memory. */
export function onSessionLoaded(handler: (payload: SessionLoadedNotification) => void) {
  return listen<SessionLoadedNotification>('session-loaded', (e) => handler(e.payload));
}

/** The session store changed, so the sidebar should refetch. */
export function onSessionsChanged(handler: () => void) {
  return listen('sessions-changed', () => handler());
}

/**
 * The sidecar exited. Every session is gone with it and nothing will answer again, so
 * this is reported rather than left to look like an app that has simply gone quiet.
 */
export function onSidecarStopped(handler: (reason: string) => void) {
  return listen<string>('sidecar-stopped', (event) => handler(event.payload));
}

/** Another sidecar took over from one that died. Anything it was told is gone. */
export function onSidecarRestarted(handler: () => void) {
  return listen('sidecar-restarted', () => handler());
}

/** A tool call is waiting on the user before it can run. */
export function onPermissionRequested(handler: (payload: PendingPermission) => void) {
  return listen<PendingPermission>('permission-requested', (e) => handler(e.payload));
}

/** A pending request was answered or abandoned and should no longer be shown. */
export function onPermissionResolved(handler: (payload: PermissionResolvedNotification) => void) {
  return listen<PermissionResolvedNotification>('permission-resolved', (e) => handler(e.payload));
}

/** The agent is asking the user a question and is blocked until it is answered. */
export function onElicitationRequested(handler: (payload: PendingElicitation) => void) {
  return listen<PendingElicitation>('elicitation-requested', (e) => handler(e.payload));
}

export function onElicitationResolved(handler: (payload: ElicitationResolvedNotification) => void) {
  return listen<ElicitationResolvedNotification>('elicitation-resolved', (e) => handler(e.payload));
}

/** Answer a question from the agent, unblocking it. */
export function resolveElicitation(
  requestId: string,
  action: ElicitationAction,
  content?: Record<string, ElicitationFieldValue>,
): Promise<void> {
  return request<void>('sessions.resolveElicitation', { requestId, action, content });
}
