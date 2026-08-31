import { createParser } from 'eventsource-parser';
import type { Capability, ConversationListItem, ConversationScope, ConversationSnapshot, QueueDelivery, QueueMutationOutcome, StreamEvent } from './types';

function workspaceHeaders(workspaceRef?: string): HeadersInit {
  return workspaceRef ? { 'X-Workspace-Ref': workspaceRef } : {};
}

export async function apiJson<T>(path: string, options: RequestInit & { workspaceRef?: string } = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...workspaceHeaders(options.workspaceRef),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export function scopeQuery(scope: ConversationScope): string {
  return scope.kind === 'general' ? 'scope=general' : `scope=workspace&workspaceRef=${encodeURIComponent(scope.workspaceRef)}`;
}

export function scopeWorkspaceRef(scope: ConversationScope): string | undefined {
  return scope.kind === 'workspace' ? scope.workspaceRef : undefined;
}

export async function listCapabilities(): Promise<Capability[]> {
  return (await apiJson<{ capabilities: Capability[] }>('/api/capabilities')).capabilities;
}

export async function resolveWorkspace(path: string) {
  return apiJson<{ workspaceRef: string; displayName: string; canonicalPath: string }>('/api/workspaces/resolve', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export async function suggestWorkspacePaths(prefix: string): Promise<string[]> {
  return (await apiJson<{ suggestions: string[] }>(`/api/fs/suggest?prefix=${encodeURIComponent(prefix)}`)).suggestions;
}

export async function listRecentWorkspaces(): Promise<Array<{ path: string; displayName: string }>> {
  return (await apiJson<{ workspaces: Array<{ path: string; displayName: string }> }>('/api/workspaces/recent')).workspaces;
}

export async function listConversations(scope: ConversationScope): Promise<ConversationListItem[]> {
  return (await apiJson<{ conversations: ConversationListItem[] }>(`/api/conversations?${scopeQuery(scope)}`, {
    workspaceRef: scopeWorkspaceRef(scope),
  })).conversations;
}

export async function getConversation(scope: ConversationScope, ref: string): Promise<ConversationSnapshot> {
  return (await apiJson<{ conversation: ConversationSnapshot }>(`/api/conversations/${encodeURIComponent(ref)}/view?${scopeQuery(scope)}`, {
    workspaceRef: scopeWorkspaceRef(scope),
  })).conversation;
}

export async function updateConversation(scope: ConversationScope, ref: string, meta: { title?: string; archived?: boolean }): Promise<void> {
  await apiJson(`/api/conversations/${encodeURIComponent(ref)}?${scopeQuery(scope)}`, {
    method: 'PATCH',
    workspaceRef: scopeWorkspaceRef(scope),
    body: JSON.stringify(meta),
  });
}

export async function deleteConversation(scope: ConversationScope, ref: string): Promise<void> {
  await apiJson(`/api/conversations/${encodeURIComponent(ref)}?${scopeQuery(scope)}`, {
    method: 'DELETE',
    workspaceRef: scopeWorkspaceRef(scope),
  });
}

export function conversationExportUrl(scope: ConversationScope, ref: string): string {
  return `/api/conversations/${encodeURIComponent(ref)}/export?${scopeQuery(scope)}${scope.kind === 'workspace' ? `&workspaceRef=${encodeURIComponent(scope.workspaceRef)}` : ''}`;
}

export async function streamConversation(input: {
  scope: ConversationScope;
  conversationRef?: string;
  clientRequestId: string;
  prompt: string;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}): Promise<void> {
  const response = await fetch('/api/conversation-runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...workspaceHeaders(scopeWorkspaceRef(input.scope)),
    },
    body: JSON.stringify({
      prompt: input.prompt,
      conversationRef: input.conversationRef,
      clientRequestId: input.clientRequestId,
      scope: input.scope.kind === 'general'
        ? { kind: 'general' }
        : { kind: 'workspace', workspaceRef: input.scope.workspaceRef },
    }),
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `发送失败（${response.status}）`);
  }
  await consumeEventStream(response, input.onEvent);
}

async function consumeEventStream(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  if (!response.body) throw new Error('服务端没有返回事件流');
  const parser = createParser({
    maxBufferSize: 2 * 1024 * 1024,
    onEvent(message) {
      try {
        onEvent(JSON.parse(message.data) as StreamEvent);
      } catch {
        throw new Error('服务端返回了无法解析的流式事件');
      }
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    parser.feed(decoder.decode(value, { stream: !done }));
    if (done) break;
  }
  parser.reset({ consume: true });
}

export async function enqueueQueuedMessage(input: {
  scope: ConversationScope;
  sessionId: string;
  content: string;
  delivery: QueueDelivery;
  expectedRunId?: string;
}): Promise<QueueMutationOutcome> {
  return apiJson(`/api/conversations/${encodeURIComponent(input.sessionId)}/queued-messages?${scopeQuery(input.scope)}`, {
    method: 'POST',
    workspaceRef: scopeWorkspaceRef(input.scope),
    body: JSON.stringify({
      content: input.content,
      delivery: input.delivery,
      operationId: crypto.randomUUID(),
      ...(input.expectedRunId ? { expectedRunId: input.expectedRunId } : {}),
    }),
  });
}

export async function promoteQueuedMessage(input: { scope: ConversationScope; sessionId: string; itemId: string; expectedRunId: string }): Promise<QueueMutationOutcome> {
  return apiJson(`/api/conversations/${encodeURIComponent(input.sessionId)}/queued-messages/${encodeURIComponent(input.itemId)}/commands?${scopeQuery(input.scope)}`, {
    method: 'POST',
    workspaceRef: scopeWorkspaceRef(input.scope),
    body: JSON.stringify({ action: 'promote_to_steer', operationId: crypto.randomUUID(), expectedRunId: input.expectedRunId }),
  });
}

export async function cancelQueuedMessage(input: { scope: ConversationScope; sessionId: string; itemId: string }): Promise<QueueMutationOutcome> {
  return apiJson(`/api/conversations/${encodeURIComponent(input.sessionId)}/queued-messages/${encodeURIComponent(input.itemId)}?${scopeQuery(input.scope)}`, {
    method: 'DELETE',
    workspaceRef: scopeWorkspaceRef(input.scope),
    body: JSON.stringify({ operationId: crypto.randomUUID() }),
  });
}

export async function reorderQueuedMessages(input: { scope: ConversationScope; sessionId: string; orderedItemIds: string[]; expectedSessionRevision: number }) {
  return apiJson<{ orderedItemIds: string[]; sessionRevision: number }>(`/api/conversations/${encodeURIComponent(input.sessionId)}/queued-messages/order?${scopeQuery(input.scope)}`, {
    method: 'PATCH',
    workspaceRef: scopeWorkspaceRef(input.scope),
    body: JSON.stringify({ orderedItemIds: input.orderedItemIds, operationId: crypto.randomUUID(), expectedSessionRevision: input.expectedSessionRevision }),
  });
}

export async function stopConversationRun(scope: ConversationScope, runId: string): Promise<void> {
  await apiJson(`/api/conversation-runs/${encodeURIComponent(runId)}/commands`, {
    method: 'POST',
    workspaceRef: scopeWorkspaceRef(scope),
    body: JSON.stringify({ action: 'stop' }),
  });
}

export async function streamQueueResume(input: { scope: ConversationScope; sessionId: string; signal: AbortSignal; onEvent: (event: StreamEvent) => void }): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(input.sessionId)}/queued-messages/commands?${scopeQuery(input.scope)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...workspaceHeaders(scopeWorkspaceRef(input.scope)) },
    body: JSON.stringify({ action: 'resume' }),
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `恢复失败（${response.status}）`);
  }
  await consumeEventStream(response, input.onEvent);
}
