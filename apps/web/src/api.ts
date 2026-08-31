import { createParser } from 'eventsource-parser';
import type { RunEventEnvelope } from '../../../packages/run-protocol/contracts';
import { isDroppableRunEvent, parseRunEventEnvelope } from '../../../packages/run-protocol/validation';
import type { Capability, ConversationListItem, ConversationScope, ConversationSnapshot } from './types';

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
  afterSeq?: number;
  onEvent: (event: RunEventEnvelope) => void;
}): Promise<{ lastSeq: number; runId?: string; terminal: boolean }> {
  let lastSeq = input.afterSeq ?? 0;
  let runId: string | undefined;
  let terminal = false;
  let streamError = false;

  for (let reconnect = 0; reconnect <= 2; reconnect += 1) {
    const pending: RunEventEnvelope[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      for (const event of pending.splice(0)) input.onEvent(event);
    };
    const deliver = (event: RunEventEnvelope) => {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      runId = event.runId;
      terminal ||= event.event.type === 'run_finished';
      streamError ||= event.event.type === 'stream_error';
      if (isDroppableRunEvent(event)) {
        pending.push(event);
        flushTimer ??= setTimeout(flush, 32);
      } else {
        flush();
        input.onEvent(event);
      }
    };

    try {
      const response = await fetch('/api/conversation-runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'X-DexCode-Stream-Version': '2',
          ...workspaceHeaders(scopeWorkspaceRef(input.scope)),
        },
        body: JSON.stringify({
          prompt: input.prompt,
          conversationRef: input.conversationRef,
          clientRequestId: input.clientRequestId,
          afterSeq: lastSeq,
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
            deliver(parseRunEventEnvelope(JSON.parse(message.data)));
          } catch (error) {
            throw new Error(error instanceof Error ? error.message : '服务端返回了无法解析的流式事件');
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
      flush();
      if (terminal || streamError) return { lastSeq, ...(runId ? { runId } : {}), terminal };
      if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (reconnect === 2) throw new Error('运行流在终态前中断');
    } catch (error) {
      flush();
      if (input.signal.aborted || reconnect === 2) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150 * (reconnect + 1)));
    }
  }
  return { lastSeq, ...(runId ? { runId } : {}), terminal };
}

export async function stopConversationRun(runRef: string): Promise<void> {
  await apiJson(`/api/conversation-runs/${encodeURIComponent(runRef)}/commands`, {
    method: 'POST',
    body: JSON.stringify({ action: 'stop' }),
  });
}
