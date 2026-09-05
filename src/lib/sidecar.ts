import { invoke } from '@tauri-apps/api/core';

import type { GetTranscriptResult, ListSessionsResult, RuntimeStatus } from '../../shared/protocol';

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
