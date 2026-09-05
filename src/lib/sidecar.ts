import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type {
  GetTranscriptResult,
  ListSessionsResult,
  RuntimeStatus,
  SendParams,
  SendResult,
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
export function getTranscript(sessionId: string, limit?: number): Promise<GetTranscriptResult> {
  return request<GetTranscriptResult>('sessions.transcript', { sessionId, limit });
}

export function getRuntimeStatus(): Promise<RuntimeStatus> {
  return request<RuntimeStatus>('runtime.status');
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

/** Live session events forwarded from the sidecar. */
export function onSessionEvent(handler: (payload: SessionEventNotification) => void) {
  return listen<SessionEventNotification>('session-event', (e) => handler(e.payload));
}

/** Notifies when a session is resumed into, or released from, memory. */
export function onSessionLoaded(handler: (payload: SessionLoadedNotification) => void) {
  return listen<SessionLoadedNotification>('session-loaded', (e) => handler(e.payload));
}
