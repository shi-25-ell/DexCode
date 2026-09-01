import { createParser } from 'eventsource-parser';
import type { RunEventEnvelope } from '../../../packages/run-protocol/contracts';
import { isDroppableRunEvent, parseRunEventEnvelope } from '../../../packages/run-protocol/validation';
import type { AgentActivityEnvelope, AgentDetail, AgentTreeSnapshot, Capability, ConversationListItem, ConversationScope, ConversationSnapshot, QueueDelivery, QueueMutationOutcome } from './types';

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
  const lastSeqByRun = new Map<string, number>();
  let rootRunId: string | undefined;
  let lastSeq = input.afterSeq ?? 0;
  let runId: string | undefined;
  let terminal = false;
  let streamError = false;
  let lastEventWasTerminal = false;
  let terminalProbeRunId: string | undefined;
  const maxReconnects = 3;

  for (let reconnect = 0; reconnect <= maxReconnects; reconnect += 1) {
    const pending: RunEventEnvelope[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      for (const event of pending.splice(0)) input.onEvent(event);
    };
    const deliver = (event: RunEventEnvelope) => {
      const previousSeq = lastSeqByRun.get(event.runId) ?? (rootRunId ? 0 : input.afterSeq ?? 0);
      if (event.seq <= previousSeq) return;
      rootRunId ??= event.runId;
      lastSeqByRun.set(event.runId, event.seq);
      lastSeq = event.seq;
      runId = event.runId;
      terminal ||= event.event.type === 'run_finished';
      streamError ||= event.event.type === 'stream_error';
      lastEventWasTerminal = event.event.type === 'run_finished';
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
          afterSeq: rootRunId ? (lastSeqByRun.get(rootRunId) ?? 0) : (input.afterSeq ?? 0),
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
      if (streamError) return { lastSeq, ...(runId ? { runId } : {}), terminal };
      if (lastEventWasTerminal && runId) {
        if (terminalProbeRunId === runId) return { lastSeq, runId, terminal };
        terminalProbeRunId = runId;
      }
      if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (reconnect === maxReconnects) throw new Error('运行流在终态前中断');
    } catch (error) {
      flush();
      if (input.signal.aborted || reconnect === maxReconnects) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150 * (reconnect + 1)));
    }
  }
  return { lastSeq, ...(runId ? { runId } : {}), terminal };
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

export async function streamQueueResume(input: { scope: ConversationScope; sessionId: string; signal: AbortSignal; onEvent: (event: RunEventEnvelope) => void }): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(input.sessionId)}/queued-messages/commands?${scopeQuery(input.scope)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-DexCode-Stream-Version': '2', ...workspaceHeaders(scopeWorkspaceRef(input.scope)) },
    body: JSON.stringify({ action: 'resume' }),
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `恢复失败（${response.status}）`);
  }
  const parser = createParser({
    maxBufferSize: 2 * 1024 * 1024,
    onEvent(message) {
      try {
        input.onEvent(parseRunEventEnvelope(JSON.parse(message.data)));
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
}

export async function stopConversationSession(scope: ConversationScope, sessionId: string): Promise<{
  ok: true;
  stopped: boolean;
  stoppedMain: boolean;
  stoppedAgents: number;
  pendingNotificationsConsumed: number;
  activeRun: { runId: string; phase: string } | null;
  agents: AgentTreeSnapshot | null;
}> {
  return apiJson(`/api/conversations/${encodeURIComponent(sessionId)}/commands?${scopeQuery(scope)}`, {
    method: 'POST',
    workspaceRef: scopeWorkspaceRef(scope),
    body: JSON.stringify({ action: 'stop_all' }),
  });
}

export async function getAgentTree(scope: ConversationScope, sessionId: string): Promise<AgentTreeSnapshot | null> {
  return (await apiJson<{ agents: AgentTreeSnapshot | null }>(`/api/session/${encodeURIComponent(sessionId)}/agents`, {
    workspaceRef: scopeWorkspaceRef(scope),
  })).agents;
}

export async function getAgentDetail(scope: ConversationScope, sessionId: string, agentId: string): Promise<AgentDetail> {
  return apiJson<AgentDetail>(`/api/session/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}`, {
    workspaceRef: scopeWorkspaceRef(scope),
  });
}

export async function stopChildAgent(scope: ConversationScope, sessionId: string, agentId: string): Promise<void> {
  await apiJson(`/api/session/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/stop`, {
    method: 'POST', workspaceRef: scopeWorkspaceRef(scope), body: JSON.stringify({ reason: 'Stopped from Agent activity view' }),
  });
}

export async function streamAgentActivity(input: {
  scope: ConversationScope; sessionId: string; afterSeq?: number; signal: AbortSignal; onEvent(event: AgentActivityEnvelope): void;
}): Promise<void> {
  const response = await fetch(`/api/session/${encodeURIComponent(input.sessionId)}/agents/events?afterSeq=${input.afterSeq ?? 0}`, {
    headers: { Accept: 'text/event-stream', ...workspaceHeaders(scopeWorkspaceRef(input.scope)) }, signal: input.signal,
  });
  if (!response.ok || !response.body) throw new Error(`Agent activity stream failed (${response.status})`);
  const parser = createParser({
    maxBufferSize: 512 * 1024,
    onEvent(message) {
      const envelope = JSON.parse(message.data) as AgentActivityEnvelope;
      if (envelope.version !== 1 || envelope.sessionId !== input.sessionId || !Number.isSafeInteger(envelope.seq) || !envelope.event?.type) return;
      input.onEvent(envelope);
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
