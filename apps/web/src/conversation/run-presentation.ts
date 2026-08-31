import type {
  CommittedAssistantMessage,
  RunApprovalRequest,
  RunEventEnvelope,
  RunPhase,
  RunTerminal,
} from '../../../../packages/run-protocol/contracts';
import type {
  ContextPresentation,
  ContextUsage,
  ConversationItem,
  ConversationSnapshot,
  ToolPresentation,
} from '../types';

const MAX_REASONING_CHARS = 64_000;
const MAX_TOOL_INPUT_CHARS = 32_000;
const MAX_TOOL_PROGRESS_CHARS = 32_000;
const MAX_TEXT_DRAFT_CHARS = 512_000;

export type AssistantDraftBlock = {
  contentIndex: number;
  kind: 'text' | 'reasoning' | 'tool_input';
  content: string;
  truncated?: boolean;
};

export type AssistantDraftView = {
  messageId: string;
  turn: number;
  blocks: Record<number, AssistantDraftBlock>;
  committed: boolean;
  hasToolCalls: boolean;
};

export type RunActivityEntry =
  | { kind: 'assistant'; messageId: string }
  | { kind: 'tool'; callId: string }
  | { kind: 'agent'; callId: string; agentId: string; agentRunId: string; turn: number }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'context'; operationRef: string };

export type ActiveRunView = {
  runId: string;
  startedAt: string;
  phase: RunPhase;
  phaseChangedAt: string;
  reasoningStartedAt?: string;
  reasoningCompletedAt?: string;
  note?: string;
  assistantDraft: AssistantDraftView | null;
  committedMessages: ConversationItem[];
  toolsByCallId: Record<string, ToolPresentation>;
  approvalsById: Record<string, Extract<ConversationItem, { kind: 'approval' }>>;
  contextsById: Record<string, ContextPresentation>;
  activityOrder: RunActivityEntry[];
};

export type RunPresentation = {
  committedItems: ConversationItem[];
  activeRun: ActiveRunView | null;
  contextUsage: ContextUsage;
  title: string;
  revision: number;
  status: 'idle' | 'running' | 'waiting' | 'failed';
  lastSeq?: number;
  needsResync: boolean;
  finalMessageId?: string;
  terminal?: RunTerminal;
  streamError?: string;
};

function interruptedSnapshot(snapshot: ConversationSnapshot): ConversationItem[] {
  if (snapshot.state !== 'running' && snapshot.state !== 'waiting') return snapshot.items;
  if (snapshot.items.some((item) => item.kind === 'error' && item.id === 'interrupted-live-run')) return snapshot.items;
  return [...snapshot.items, {
    id: 'interrupted-live-run',
    kind: 'error',
    title: '上次运行已中断',
    message: '页面无法恢复未提交的实时内容，已保留可以确认的会话记录。',
  }];
}

export function hydrateRunPresentation(snapshot: ConversationSnapshot): RunPresentation {
  const cannotRecoverLiveRun = snapshot.state === 'running' || snapshot.state === 'waiting';
  return {
    committedItems: interruptedSnapshot(snapshot),
    activeRun: null,
    contextUsage: snapshot.contextUsage,
    title: snapshot.title,
    revision: snapshot.revision,
    status: cannotRecoverLiveRun ? 'failed' : snapshot.state,
    needsResync: false,
  };
}

function shortTitle(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ');
  return Array.from(normalized).length > 36 ? `${Array.from(normalized).slice(0, 36).join('')}…` : normalized;
}

export function beginRunPresentation(state: RunPresentation, input: { content: string; clientRequestId: string; at?: string }): RunPresentation {
  const at = input.at ?? new Date().toISOString();
  return {
    ...state,
    committedItems: [...state.committedItems, { id: `local-user-${input.clientRequestId}`, kind: 'user', content: input.content }],
    activeRun: {
      runId: `pending:${input.clientRequestId}`,
      startedAt: at,
      phase: 'preparing_context',
      phaseChangedAt: at,
      assistantDraft: null,
      committedMessages: [],
      toolsByCallId: {},
      approvalsById: {},
      contextsById: {},
      activityOrder: [],
    },
    title: state.committedItems.length === 0 ? shortTitle(input.content) : state.title,
    status: 'running',
    lastSeq: undefined,
    needsResync: false,
    terminal: undefined,
    streamError: undefined,
    finalMessageId: undefined,
  };
}

export function failRunPresentation(state: RunPresentation, message: string): RunPresentation {
  return { ...state, status: 'failed', streamError: message };
}

function createActiveRun(envelope: RunEventEnvelope): ActiveRunView {
  return {
    runId: envelope.runId,
    startedAt: envelope.at,
    phase: 'preparing_context',
    phaseChangedAt: envelope.at,
    assistantDraft: null,
    committedMessages: [],
    toolsByCallId: {},
    approvalsById: {},
    contextsById: {},
    activityOrder: [],
  };
}

function activityKey(entry: RunActivityEntry): string {
  if (entry.kind === 'assistant') return `assistant:${entry.messageId}`;
  if (entry.kind === 'tool') return `tool:${entry.callId}`;
  if (entry.kind === 'agent') return `agent:${entry.callId}`;
  if (entry.kind === 'approval') return `approval:${entry.approvalId}`;
  return `context:${entry.operationRef}`;
}

function appendActivity(active: ActiveRunView, entry: RunActivityEntry): RunActivityEntry[] {
  const key = activityKey(entry);
  return active.activityOrder.some((item) => activityKey(item) === key)
    ? active.activityOrder
    : [...active.activityOrder, entry];
}

function appendBounded(current: string, delta: string, limit: number): { content: string; truncated: boolean } {
  const next = current + delta;
  if (next.length <= limit) return { content: next, truncated: false };
  return { content: next.slice(0, limit), truncated: true };
}

function draftFromCommitted(message: CommittedAssistantMessage): AssistantDraftView {
  const blocks: Record<number, AssistantDraftBlock> = {};
  for (const block of message.contentBlocks) {
    if (block.kind === 'reasoning') {
      blocks[block.contentIndex] = {
        contentIndex: block.contentIndex,
        kind: block.kind,
        content: block.content.slice(0, MAX_REASONING_CHARS),
        ...((block.truncated || block.content.length > MAX_REASONING_CHARS) ? { truncated: true } : {}),
      };
    } else {
      blocks[block.contentIndex] = {
        contentIndex: block.contentIndex,
        kind: block.kind,
        content: block.content.slice(0, MAX_TEXT_DRAFT_CHARS),
        ...((block.truncated || block.content.length > MAX_TEXT_DRAFT_CHARS) ? { truncated: true } : {}),
      };
    }
  }
  return {
    messageId: message.messageId,
    turn: message.turn,
    blocks,
    committed: true,
    hasToolCalls: message.toolCalls.length > 0,
  };
}

function approvalItem(request: RunApprovalRequest): Extract<ConversationItem, { kind: 'approval' }> {
  if (request.kind === 'tool') return {
    id: `approval-${request.approvalId}`,
    kind: 'approval',
    approvalRef: request.approvalId,
    approvalKind: 'tool',
    toolName: request.toolName,
    effect: request.effect,
    title: request.title,
    ...(request.target ? { target: request.target } : {}),
    reason: request.reason,
    fingerprint: request.fingerprint,
    options: request.options,
  };
  if (request.kind === 'command') return {
    id: `approval-${request.approvalId}`,
    kind: 'approval',
    approvalRef: request.approvalId,
    approvalKind: 'command',
    title: request.title,
    target: request.target,
    reason: request.reason,
    options: request.options,
  };
  return {
    id: `approval-${request.approvalId}`,
    kind: 'approval',
    approvalRef: request.approvalId,
    approvalKind: 'question',
    title: request.title,
    options: request.options,
  };
}

function boundedTool(presentation: ToolPresentation): ToolPresentation {
  if (!presentation.rawOutput || presentation.rawOutput.length <= MAX_TOOL_PROGRESS_CHARS) return presentation;
  return { ...presentation, rawOutput: presentation.rawOutput.slice(0, MAX_TOOL_PROGRESS_CHARS), truncated: true };
}

function applyEvent(state: RunPresentation, envelope: RunEventEnvelope, active: ActiveRunView): RunPresentation {
  const event = envelope.event;
  if (event.type === 'run_started') {
    return { ...state, activeRun: { ...active, runId: envelope.runId, startedAt: envelope.at }, status: 'running' };
  }
  if (event.type === 'run_phase_changed') {
    const { note: _previousNote, ...activeWithoutNote } = active;
    const reasoningCompletedAt = active.reasoningStartedAt && !active.reasoningCompletedAt && active.phase === 'thinking' && event.phase !== 'thinking'
      ? envelope.at
      : active.reasoningCompletedAt;
    return {
      ...state,
      activeRun: {
        ...activeWithoutNote,
        phase: event.phase,
        phaseChangedAt: envelope.at,
        ...(reasoningCompletedAt ? { reasoningCompletedAt } : {}),
        ...(event.note ? { note: event.note } : {}),
      },
      status: event.phase === 'waiting_approval' ? 'waiting' : 'running',
    };
  }
  if (event.type === 'assistant_message_started') {
    return {
      ...state,
      activeRun: {
        ...active,
        assistantDraft: { messageId: event.messageId, turn: event.turn, blocks: {}, committed: false, hasToolCalls: false },
        activityOrder: appendActivity(active, { kind: 'assistant', messageId: event.messageId }),
      },
    };
  }
  if (event.type === 'assistant_content_delta') {
    if (!active.assistantDraft || active.assistantDraft.messageId !== event.messageId) return { ...state, needsResync: true };
    const previous = active.assistantDraft.blocks[event.contentIndex];
    const limit = event.kind === 'reasoning' ? MAX_REASONING_CHARS : event.kind === 'tool_input' ? MAX_TOOL_INPUT_CHARS : MAX_TEXT_DRAFT_CHARS;
    const appended = appendBounded(previous?.content ?? '', event.delta, limit);
    const block: AssistantDraftBlock = {
      contentIndex: event.contentIndex,
      kind: event.kind,
      content: appended.content,
      ...((previous?.truncated || appended.truncated) ? { truncated: true } : {}),
    };
    return {
      ...state,
      activeRun: {
        ...active,
        ...(event.kind === 'reasoning' && !active.reasoningStartedAt ? { reasoningStartedAt: envelope.at } : {}),
        ...(event.kind !== 'reasoning' && active.reasoningStartedAt && !active.reasoningCompletedAt ? { reasoningCompletedAt: envelope.at } : {}),
        assistantDraft: { ...active.assistantDraft, blocks: { ...active.assistantDraft.blocks, [event.contentIndex]: block } },
      },
    };
  }
  if (event.type === 'assistant_message_reset') {
    if (!active.assistantDraft || active.assistantDraft.messageId !== event.messageId) return { ...state, needsResync: true };
    return {
      ...state,
      activeRun: {
        ...active,
        assistantDraft: { ...active.assistantDraft, blocks: {}, hasToolCalls: false },
      },
    };
  }
  if (event.type === 'assistant_message_committed') {
    const draft = draftFromCommitted(event.message);
    const committedMessages = event.message.toolCalls.length > 0 && event.message.content.trim()
      ? [...active.committedMessages, {
          id: event.message.messageId,
          kind: 'assistant' as const,
          content: event.message.content,
          messageId: event.message.messageId,
          runId: envelope.runId,
          turn: event.turn,
        }]
      : active.committedMessages;
    return {
      ...state,
      activeRun: {
        ...active,
        committedMessages,
        assistantDraft: event.message.toolCalls.length > 0 ? null : draft,
        activityOrder: appendActivity(active, { kind: 'assistant', messageId: event.message.messageId }),
      },
      ...(!event.message.toolCalls.length ? { finalMessageId: event.message.messageId } : {}),
    };
  }
  if (event.type === 'tool_started' || event.type === 'tool_progress' || event.type === 'tool_finished') {
    return {
      ...state,
      activeRun: {
        ...active,
        toolsByCallId: { ...active.toolsByCallId, [event.callId]: boundedTool(event.presentation as ToolPresentation) },
        activityOrder: appendActivity(active, { kind: 'tool', callId: event.callId }),
      },
    };
  }
  if (event.type === 'approval_requested') {
    const item = approvalItem(event.request);
    return {
      ...state,
      activeRun: {
        ...active,
        approvalsById: { ...active.approvalsById, [event.request.approvalId]: item },
        activityOrder: appendActivity(active, { kind: 'approval', approvalId: event.request.approvalId }),
      },
      status: 'waiting',
    };
  }
  if (event.type === 'approval_resolved') {
    const item = active.approvalsById[event.approvalId];
    if (!item) return { ...state, needsResync: true };
    return {
      ...state,
      activeRun: { ...active, approvalsById: { ...active.approvalsById, [event.approvalId]: { ...item, resolved: event.decision } } },
      status: 'running',
    };
  }
  if (event.type === 'context_usage_changed') return { ...state, contextUsage: event.usage };
  if (event.type === 'context_activity_changed') {
    return {
      ...state,
      activeRun: {
        ...active,
        contextsById: { ...active.contextsById, [event.presentation.operationRef]: event.presentation },
        activityOrder: appendActivity(active, { kind: 'context', operationRef: event.presentation.operationRef }),
      },
    };
  }
  if (event.type === 'agent_invocation_started') {
    return {
      ...state,
      activeRun: {
        ...active,
        activityOrder: appendActivity(active, {
          kind: 'agent',
          callId: event.callId,
          agentId: event.agentId,
          agentRunId: event.agentRunId,
          turn: event.turn,
        }),
      },
    };
  }
  if (event.type === 'run_finished') {
    const finalMessageId = event.finalMessageId;
    const items = event.conversation.items.map((item) => (
      item.kind === 'assistant' && finalMessageId && (item.messageId === finalMessageId || item.id === finalMessageId)
        ? { ...item, final: true }
        : item
    )) as ConversationItem[];
    return {
      committedItems: items,
      activeRun: null,
      contextUsage: event.conversation.contextUsage,
      title: event.conversation.title,
      revision: event.conversationRevision,
      status: event.terminal.status === 'completed' ? 'idle' : 'failed',
      lastSeq: envelope.seq,
      needsResync: false,
      terminal: event.terminal,
      ...(finalMessageId ? { finalMessageId } : {}),
    };
  }
  if (event.type === 'resync_required') return { ...state, needsResync: true };
  if (event.type === 'stream_error') return { ...state, activeRun: null, status: 'failed', streamError: event.message };
  return state;
}

export function reduceRunEvent(state: RunPresentation, envelope: RunEventEnvelope): RunPresentation {
  if (envelope.version !== 2 || !envelope.runId || !Number.isSafeInteger(envelope.seq) || envelope.seq <= 0) {
    return { ...state, status: 'failed', streamError: '服务端返回了无效的运行事件' };
  }
  const startsNextRun = envelope.event.type === 'run_started'
    && envelope.seq === 1
    && !state.activeRun
    && Boolean(state.terminal);
  if (!startsNextRun && state.lastSeq !== undefined && envelope.seq <= state.lastSeq) return state;
  if (startsNextRun) {
    const active = createActiveRun(envelope);
    return applyEvent({
      ...state,
      activeRun: active,
      lastSeq: 1,
      needsResync: false,
      terminal: undefined,
      streamError: undefined,
      finalMessageId: undefined,
    }, envelope, active);
  }
  const active = state.activeRun ?? createActiveRun(envelope);
  if (!active.runId.startsWith('pending:') && active.runId !== envelope.runId) {
    return { ...state, needsResync: true, status: 'failed', streamError: '运行事件串流到了错误的 Run' };
  }
  const gap = state.lastSeq !== undefined ? envelope.seq !== state.lastSeq + 1 : envelope.seq !== 1;
  const nextBase = { ...state, activeRun: active, lastSeq: envelope.seq, ...(gap ? { needsResync: true } : {}) };
  if (gap && (envelope.event.type === 'assistant_content_delta' || envelope.event.type === 'tool_progress')) return nextBase;
  return applyEvent(nextBase, envelope, active);
}

export function draftText(draft: AssistantDraftView | null): string {
  if (!draft) return '';
  return Object.values(draft.blocks)
    .filter((block) => block.kind === 'text')
    .sort((left, right) => left.contentIndex - right.contentIndex)
    .map((block) => block.content)
    .join('');
}

export function draftReasoning(draft: AssistantDraftView | null): { content: string; truncated: boolean } | null {
  if (!draft) return null;
  const blocks = Object.values(draft.blocks).filter((block) => block.kind === 'reasoning').sort((left, right) => left.contentIndex - right.contentIndex);
  if (blocks.length === 0) return null;
  return { content: blocks.map((block) => block.content).join(''), truncated: blocks.some((block) => block.truncated) };
}
