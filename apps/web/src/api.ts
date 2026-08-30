import { createParser } from 'eventsource-parser';
import type { Capability, ConversationListItem, ConversationScope, ConversationSnapshot, StreamEvent } from './types';

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
  const parser = createParser({
    maxBufferSize: 2 * 1024 * 1024,
    onEvent(message) {
      try {
        input.onEvent(JSON.parse(message.data) as StreamEvent);
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
