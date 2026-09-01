import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Square } from 'lucide-react';
import { Fragment, type FormEvent, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiJson, cancelQueuedMessage, enqueueQueuedMessage, getAgentTree, getConversation, promoteQueuedMessage, reorderQueuedMessages, scopeWorkspaceRef, stopChildAgent, stopConversationRun, stopConversationSession, streamAgentActivity, streamConversation, streamExistingConversationRun, streamQueueResume } from '../api';
import type { RunEventEnvelope } from '../../../../packages/run-protocol/contracts';
import { AppShell } from '../shell/app-shell';
import type { AgentTreeSnapshot, ContextUsage, ConversationItem, ConversationScope, ConversationSnapshot, FollowUpBehavior, QueueItem, QueueMutationOutcome } from '../types';
import { ApprovalCard } from './approval-card';
import { AssistantMessage } from './assistant-message';
import { assistantResponseCopyText, groupConversationHistory, isCompleteAssistantResponse } from './response-boundary';
import { ToolCard } from './tool-card';
import { ToolBatchCard } from './tool-batch-card';
import { ContextCard } from './context-card';
import { RunActivity } from './run-activity';
import {
  beginRunPresentation,
  failRunPresentation,
  hydrateRunPresentation,
  reduceRunEvent,
  type RunPresentation,
} from './run-presentation';
import { isTimelineNearBottom } from './scroll-follow';
import { UserMessage } from './user-message';
import { initialQueueState, queueReducer } from './queue-reducer';
import { QueuedMessageCard } from './queued-message-card';
import { deliveryForFollowUp, readFollowUpBehavior, writeFollowUpBehavior } from '../settings/follow-up-behavior';
import { agentActivityReducer, initialAgentActivityState } from './agent-reducer';
import { AgentActivityCard, AgentDrawer } from './agent-activity';
import { groupAgentTimeline } from './agent-timeline';
import { ExecutionHistoryDisclosure } from './execution-history';

type PageAction =
  | { type: 'hydrate'; snapshot: ConversationSnapshot }
  | { type: 'begin'; content: string; clientRequestId: string }
  | { type: 'commit_queued_user'; itemId: string; content: string; delivery?: 'steer' }
  | { type: 'run_event'; event: RunEventEnvelope }
  | { type: 'error'; message: string };

type ConversationStreamToken = { identity: string };

const TOOLS_WITHOUT_PRESENTATION_FINISH = new Set([
  'compact_context',
  'spawn_agent',
  'wait_agent',
  'followup_agent',
  'stop_agent',
]);

export function toolCallIdsRequiringPresentationSettlement(toolCalls: ReadonlyArray<{ callId: string; name: string }>): string[] {
  return toolCalls
    .filter((call) => !TOOLS_WITHOUT_PRESENTATION_FINISH.has(call.name))
    .map((call) => call.callId);
}

function ConversationTimelineItem({ item, status, workspaceRef, agentTree, onOpenAgent, onStopAgent }: {
  item: ConversationItem;
  status: RunPresentation['status'];
  workspaceRef?: string;
  agentTree: AgentTreeSnapshot | null;
  onOpenAgent(agentId?: string): void;
  onStopAgent(agentId: string): void;
}) {
  if (item.kind === 'user') return <UserMessage content={item.content} />;
  if (item.kind === 'assistant') {
    const showCopy = isCompleteAssistantResponse(item, status);
    return <AssistantMessage content={item.content} copyContent={assistantResponseCopyText(item)} showCopy={showCopy} />;
  }
  if (item.kind === 'tool') return <ToolCard tool={item.tool} />;
  if (item.kind === 'tool_batch') return <ToolBatchCard batch={item.batch} />;
  if (item.kind === 'context') return <ContextCard context={item.context} />;
  if (item.kind === 'agent_activity') return agentTree ? <AgentActivityCard tree={agentTree} agentRunIds={item.agentRunIds} onOpen={onOpenAgent} onStop={onStopAgent} /> : null;
  if (item.kind === 'approval') return <ApprovalCard item={item} workspaceRef={workspaceRef} />;
  return <div className="error-card"><strong>{item.title}</strong><span>{item.message}</span></div>;
}

const emptySnapshot: ConversationSnapshot = {
  ref: 'draft',
  title: '新会话',
  state: 'idle',
  updatedAt: '',
  revision: 0,
  queuedItems: [],
  queuePaused: false,
  items: [],
  contextUsage: { source: 'unknown', timing: 'next_request' },
};

function pageReducer(state: RunPresentation, action: PageAction): RunPresentation {
  if (action.type === 'hydrate') return hydrateRunPresentation(action.snapshot);
  if (action.type === 'begin') return beginRunPresentation(state, action);
  if (action.type === 'commit_queued_user') {
    const id = `queued-user-${action.itemId}`;
    if (state.committedItems.some((item) => item.id === id)) return state;
    if (state.activeRun) {
      if (state.activeRun.activityOrder.some((entry) => entry.kind === 'user' && entry.itemId === action.itemId)) return state;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          activityOrder: [...state.activeRun.activityOrder, {
            kind: 'user',
            itemId: action.itemId,
            content: action.content,
            ...(action.delivery ? { delivery: action.delivery } : {}),
          }],
        },
      };
    }
    return { ...state, committedItems: [...state.committedItems, { id, kind: 'user', content: action.content, ...(action.delivery ? { delivery: action.delivery } : {}) }] };
  }
  if (action.type === 'run_event') return reduceRunEvent(state, action.event);
  return failRunPresentation(state, action.message);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function terminalTitle(status: string, reason: string): string {
  if (status === 'aborted') return '运行已取消';
  if (reason === 'model_turn_limit') return '模型回合数达到限制';
  if (reason === 'model_attempt_limit') return '模型尝试次数达到限制';
  if (reason === 'output_token_limit') return '单次模型输出达到长度限制';
  if (reason === 'total_token_limit') return '累计令牌达到限制';
  if (reason === 'orchestration_stalled') return '多智能体编排因无进展已停止';
  return status === 'limited' ? '运行达到限制' : '运行未完成';
}

export function hasActiveConversationWork(input: { activeRun?: unknown; agents?: AgentTreeSnapshot | null }): boolean {
  return Boolean(input.activeRun) || Boolean(input.agents?.runs.some((run) => run.status === 'running'));
}

function ContextLabel({ usage, running }: { usage: ContextUsage; running: boolean }) {
  if (usage.percentage === undefined) return <span>{running && usage.source === 'unknown' ? '上下文计算中' : '上下文未知'}</span>;
  const detail = usage.usedTokens !== undefined && usage.contextWindowTokens !== undefined
    ? `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.contextWindowTokens)} tokens`
    : '';
  const timing = usage.timing === 'last_request' ? '最近一次模型请求' : '下一次模型请求';
  const source = usage.source === 'provider' ? '模型实测' : '校准估算';
  const estimated = usage.source === 'estimated' || usage.source === 'calibrated';
  return <span title={`${detail} · ${timing} · ${source}${usage.breakdownEstimated ? ' · 构成估算' : ''}`}>上下文 {usage.percentage}%{estimated ? ' · 估算' : ''}</span>;
}

export function shouldShowConversationLoading(input: {
  hasConversationRef: boolean;
  hasSnapshot: boolean;
  snapshotPending: boolean;
  materializingDraft: boolean;
}): boolean {
  return input.hasConversationRef
    && !input.hasSnapshot
    && input.snapshotPending
    && !input.materializingDraft;
}

export function ConversationPage({ scope, conversationRef }: { scope: ConversationScope; conversationRef?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(pageReducer, emptySnapshot, hydrateRunPresentation);
  const [queueState, queueDispatch] = useReducer(queueReducer, initialQueueState);
  const [agentState, agentDispatch] = useReducer(agentActivityReducer, initialAgentActivityState);
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [agentWakePolling, setAgentWakePolling] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [followUpBehavior, setFollowUpBehavior] = useState<FollowUpBehavior>(() => readFollowUpBehavior());
  const [queueBusy, setQueueBusy] = useState<Set<string>>(() => new Set());
  const [optimisticQueueItems, setOptimisticQueueItems] = useState<QueueItem[]>([]);
  const [presentedSteerIds, setPresentedSteerIds] = useState<Set<string>>(() => new Set());
  const [queueNotice, setQueueNotice] = useState('');
  const [stopping, setStopping] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const clientRequestIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const streamingRef = useRef(false);
  const draggedQueueItem = useRef<string | null>(null);
  const queueBusyRef = useRef<Set<string>>(new Set());
  const queuedItemsRef = useRef<Map<string, QueueItem>>(new Map());
  const pendingSteersRef = useRef<Map<string, string>>(new Map());
  const unsettledToolCallsRef = useRef<Set<string>>(new Set());
  const transcriptStableRef = useRef(false);
  const workspaceRef = scopeWorkspaceRef(scope);
  const scopeIdentity = scope.kind === 'workspace' ? `workspace:${scope.workspaceRef}` : 'general';
  const conversationIdentity = `${scopeIdentity}:${conversationRef ?? 'draft'}`;
  const previousConversationIdentityRef = useRef(conversationIdentity);
  const currentConversationIdentityRef = useRef(conversationIdentity);
  const activeStreamTokenRef = useRef<ConversationStreamToken | null>(null);
  const snapshot = useQuery({
    queryKey: ['conversation', scope, conversationRef],
    queryFn: () => getConversation(scope, conversationRef!),
    enabled: Boolean(conversationRef),
    refetchInterval: (query) => hasActiveConversationWork({ activeRun: query.state.data?.activeRun, agents: query.state.data?.agents }) || agentWakePolling ? 1_000 : false,
  });
  const meta = useQuery({
    queryKey: ['meta', workspaceRef],
    queryFn: () => apiJson<{ model: { displayName: string; contextWindow?: number }; multiAgentEnabled?: boolean }>('/api/meta', { workspaceRef }),
    staleTime: 60_000,
  });
  const agents = useQuery({
    queryKey: ['agents', scope, conversationRef],
    queryFn: () => getAgentTree(scope, conversationRef!),
    enabled: scope.kind === 'workspace' && Boolean(conversationRef) && meta.data?.multiAgentEnabled === true,
  });
  const agentTree = agentState.tree ?? snapshot.data?.agents ?? null;
  const sessionHasActiveWork = Boolean(state.activeRun || streamingRef.current)
    || hasActiveConversationWork({ activeRun: snapshot.data?.activeRun, agents: agentTree });
  const loadingConversation = shouldShowConversationLoading({
    hasConversationRef: Boolean(conversationRef),
    hasSnapshot: Boolean(snapshot.data),
    snapshotPending: snapshot.isPending,
    materializingDraft: Boolean(state.activeRun && streamingRef.current),
  });

  useEffect(() => {
    const previousIdentity = previousConversationIdentityRef.current;
    const materializedCurrentDraft = previousIdentity === `${scopeIdentity}:draft`
      && Boolean(conversationRef)
      && streamingRef.current
      && activeStreamTokenRef.current?.identity === conversationIdentity;
    previousConversationIdentityRef.current = conversationIdentity;
    currentConversationIdentityRef.current = conversationIdentity;
    stickToBottom.current = true;
    setAtBottom(true);

    if (!materializedCurrentDraft && (previousIdentity !== conversationIdentity || !conversationRef)) {
      controllerRef.current?.abort();
      activeStreamTokenRef.current = null;
      streamingRef.current = false;
      controllerRef.current = null;
      runIdRef.current = null;
      clientRequestIdRef.current = null;
      queueDispatch({ type: 'session_reset' });
      queuedItemsRef.current.clear();
      pendingSteersRef.current.clear();
      unsettledToolCallsRef.current.clear();
      transcriptStableRef.current = false;
      setOptimisticQueueItems([]);
      setPresentedSteerIds(new Set());
      agentDispatch({ type: 'reset' });
      setAgentDrawerOpen(false);
      setSelectedAgentId(undefined);
      if (conversationRef) {
        dispatch({ type: 'hydrate', snapshot: {
          ref: conversationRef,
          title: '加载会话…',
          state: 'idle',
          updatedAt: '',
          items: [],
          queuedItems: [],
          queuePaused: false,
          revision: 0,
          contextUsage: { source: 'unknown', timing: 'next_request' },
        } });
      }
    }
    if (!conversationRef) {
      dispatch({ type: 'hydrate', snapshot: { ref: 'draft', title: '新会话', state: 'idle', updatedAt: '', items: [], queuedItems: [], queuePaused: false, revision: 0, contextUsage: { source: 'unknown', timing: 'next_request' } } });
    }
  }, [conversationIdentity, conversationRef, scopeIdentity]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (agents.data !== undefined) agentDispatch({ type: 'hydrate', tree: agents.data });
  }, [agents.data]);

  useEffect(() => {
    if (scope.kind !== 'workspace' || !conversationRef || meta.data?.multiAgentEnabled !== true || agents.data === undefined) return;
    const controller = new AbortController();
    void streamAgentActivity({
      scope, sessionId: conversationRef, signal: controller.signal,
      onEvent(envelope) {
        agentDispatch({ type: 'event', envelope });
        if (envelope.event.type === 'agent_resync_required') void queryClient.invalidateQueries({ queryKey: ['agents', scope, conversationRef] });
        if (envelope.event.type === 'agent_run_finished' || envelope.event.type === 'agent_recovered') {
          setAgentWakePolling(true);
          void queryClient.invalidateQueries({ queryKey: ['agent-detail', scope, conversationRef] });
          void queryClient.invalidateQueries({ queryKey: ['conversation', scope, conversationRef] });
        }
      },
    }).catch((error) => { if (!controller.signal.aborted) console.warn('Agent activity stream ended', error); });
    return () => controller.abort();
  }, [agents.data === undefined, conversationRef, meta.data?.multiAgentEnabled, queryClient, scopeIdentity]);

  useEffect(() => {
    if (!agentWakePolling) return;
    const timer = window.setTimeout(() => setAgentWakePolling(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [agentWakePolling]);

  useEffect(() => {
    if (agentState.needsResync && conversationRef) void queryClient.invalidateQueries({ queryKey: ['agents', scope, conversationRef] });
  }, [agentState.needsResync, conversationRef, queryClient, scopeIdentity]);

  useEffect(() => {
    if (snapshot.data && snapshot.data.ref === conversationRef && !streamingRef.current) {
      queuedItemsRef.current = new Map(snapshot.data.queuedItems.map((item) => [item.itemId, item]));
      dispatch({ type: 'hydrate', snapshot: snapshot.data });
      queueDispatch({
        type: 'queue_snapshot',
        items: snapshot.data.queuedItems,
        revision: snapshot.data.revision,
        paused: snapshot.data.queuePaused,
        ...(snapshot.data.activeRun ? { activeRunId: snapshot.data.activeRun.runId } : {}),
      });
    }
  }, [conversationRef, snapshot.data]);

  useLayoutEffect(() => {
    if (!stickToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = element.scrollHeight;
      setAtBottom(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [state.committedItems, state.lastSeq]);

  useEffect(() => {
    const timelineElement = timelineRef.current;
    const scrollElement = scrollRef.current;
    if (!timelineElement || !scrollElement || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottom.current) return;
      scrollElement.scrollTop = scrollElement.scrollHeight;
      setAtBottom(true);
    });
    observer.observe(timelineElement);
    return () => observer.disconnect();
  }, []);

  const presentPendingSteers = () => {
    if (!transcriptStableRef.current || pendingSteersRef.current.size === 0) return;
    const pending = [...pendingSteersRef.current.entries()];
    pendingSteersRef.current.clear();
    setPresentedSteerIds((current) => {
      const next = new Set(current);
      for (const [itemId] of pending) next.add(itemId);
      return next;
    });
    for (const [itemId, content] of pending) {
      dispatch({ type: 'commit_queued_user', itemId, content, delivery: 'steer' });
    }
  };

  const stageSteerForTranscript = (item: QueueItem) => {
    pendingSteersRef.current.set(item.itemId, item.content);
    presentPendingSteers();
  };

  const handleStreamEvent = (envelope: RunEventEnvelope, token: ConversationStreamToken) => {
    const event = envelope.event;
    if (event.type === 'run_started' && event.isNew) {
      const wasVisible = activeStreamTokenRef.current === token
        && currentConversationIdentityRef.current === token.identity;
      token.identity = `${scopeIdentity}:${event.sessionId}`;
      if (wasVisible) {
        currentConversationIdentityRef.current = token.identity;
        const next = scope.kind === 'general'
          ? `/c/${encodeURIComponent(event.sessionId)}`
          : `/w/${encodeURIComponent(scope.workspaceRef)}/c/${encodeURIComponent(event.sessionId)}`;
        navigate(next, { replace: true });
      }
    }
    if (activeStreamTokenRef.current !== token || currentConversationIdentityRef.current !== token.identity) {
      if (event.type === 'run_finished') {
        queryClient.setQueryData<ConversationSnapshot>(['conversation', scope, event.conversation.ref], event.conversation as ConversationSnapshot);
      }
      return;
    }
    runIdRef.current = envelope.runId;
    let presentSteersAfterEvent = false;
    if (event.type === 'run_started') {
      transcriptStableRef.current = false;
      unsettledToolCallsRef.current.clear();
    } else if (event.type === 'assistant_message_started' || event.type === 'assistant_message_reset' || event.type === 'assistant_content_delta') {
      transcriptStableRef.current = false;
    } else if (event.type === 'assistant_message_committed') {
      unsettledToolCallsRef.current = new Set(toolCallIdsRequiringPresentationSettlement(event.message.toolCalls));
      transcriptStableRef.current = unsettledToolCallsRef.current.size === 0;
      presentSteersAfterEvent = transcriptStableRef.current;
    } else if (event.type === 'tool_started') {
      transcriptStableRef.current = false;
    } else if (event.type === 'tool_finished') {
      unsettledToolCallsRef.current.delete(event.callId);
      if (unsettledToolCallsRef.current.size === 0) {
        transcriptStableRef.current = true;
        presentSteersAfterEvent = true;
      }
    }
    if (event.type === 'queue_item_added' || event.type === 'queue_item_updated') {
      queuedItemsRef.current.set(event.item.itemId, event.item);
      queueDispatch({ type: 'queue_upsert', item: event.item, revision: event.sessionRevision });
    } else if (event.type === 'queue_item_removed') {
      queueDispatch({ type: 'queue_remove', itemId: event.itemId, revision: event.sessionRevision });
    } else if (event.type === 'queue_reordered') {
      queueDispatch({ type: 'queue_reorder', orderedItemIds: event.orderedItemIds, revision: event.sessionRevision });
    } else if (event.type === 'user_message_committed') {
      const item = queuedItemsRef.current.get(event.itemId);
      pendingSteersRef.current.delete(event.itemId);
      if (item) {
        setPresentedSteerIds((current) => new Set(current).add(event.itemId));
        dispatch({ type: 'commit_queued_user', itemId: event.itemId, content: item.content, ...(item.delivery === 'steer' ? { delivery: 'steer' as const } : {}) });
      }
    } else if (event.type === 'run_started') {
      queueDispatch({ type: 'run_started', runId: envelope.runId, ...(event.sourceItemId ? { sourceItemId: event.sourceItemId } : {}) });
    } else if (event.type === 'run_chain_paused') {
      queueDispatch({ type: 'run_chain_paused' });
    } else if (event.type === 'context_refresh_failed') {
      setQueueNotice(`方向已更新，但上下文刷新失败：${event.message}`);
    } else if (event.type === 'run_finished') {
      transcriptStableRef.current = true;
      queueDispatch({
        type: 'queue_snapshot',
        items: event.conversation.queuedItems,
        revision: event.conversation.revision,
        paused: event.conversation.queuePaused,
        ...(event.conversation.activeRun ? { activeRunId: event.conversation.activeRun.runId } : {}),
      });
      queryClient.setQueryData<ConversationSnapshot>(['conversation', scope, event.conversation.ref], event.conversation as ConversationSnapshot);
      setPresentedSteerIds(new Set());
    }
    dispatch({ type: 'run_event', event: envelope });
    if (presentSteersAfterEvent) presentPendingSteers();
  };

  useEffect(() => {
    const activeRunId = snapshot.data?.activeRun?.runId;
    if (!conversationRef || !activeRunId || streamingRef.current) return;
    const controller = new AbortController();
    const streamToken: ConversationStreamToken = { identity: conversationIdentity };
    activeStreamTokenRef.current = streamToken;
    controllerRef.current = controller;
    runIdRef.current = activeRunId;
    streamingRef.current = true;
    void streamExistingConversationRun({
      scope,
      runId: activeRunId,
      signal: controller.signal,
      onEvent: (envelope) => handleStreamEvent(envelope, streamToken),
    }).catch(() => {
      if (!controller.signal.aborted) void queryClient.invalidateQueries({ queryKey: ['conversation', scope, conversationRef] });
    }).finally(() => {
      if (activeStreamTokenRef.current !== streamToken) return;
      activeStreamTokenRef.current = null;
      controllerRef.current = null;
      runIdRef.current = null;
      streamingRef.current = false;
      void queryClient.invalidateQueries({ queryKey: ['conversation', scope, conversationRef] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', scope] });
    });
  }, [conversationIdentity, conversationRef, snapshot.data?.activeRun?.runId]);

  const applyQueueOutcome = (outcome: QueueMutationOutcome) => {
    if (outcome.outcome === 'queued' || outcome.outcome === 'steered' || outcome.outcome === 'remained_queued') {
      queuedItemsRef.current.set(outcome.item.itemId, outcome.item);
      queueDispatch({ type: 'queue_upsert', item: outcome.item, revision: outcome.sessionRevision });
      if (outcome.outcome === 'steered') stageSteerForTranscript(outcome.item);
      if (outcome.outcome === 'remained_queued') {
        setQueueNotice('当前运行已进入结束阶段，这条消息会在下一轮处理。');
      } else if (outcome.outcome === 'steered' && state.status === 'waiting') {
        setQueueNotice('已绑定当前任务，将在批准完成且工具结算后调整方向。');
      }
      return;
    }
    queueDispatch({ type: 'queue_remove', itemId: outcome.itemId, revision: outcome.sessionRevision });
    if (outcome.outcome === 'already_consumed') setQueueNotice('这条消息已经进入对话。');
  };

  const markQueueBusy = (itemId: string, busy: boolean) => {
    const next = new Set(queueBusyRef.current);
    if (busy) next.add(itemId);
    else next.delete(itemId);
    queueBusyRef.current = next;
    setQueueBusy(next);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = prompt.trim();
    if (!content || queueBusyRef.current.has('enqueue')) return;
    if (sessionHasActiveWork && conversationRef) {
      const optimisticId = `optimistic-${crypto.randomUUID()}`;
      const delivery = deliveryForFollowUp(followUpBehavior);
      const now = new Date().toISOString();
      setOptimisticQueueItems((items) => [...items, {
        itemId: optimisticId,
        sessionId: conversationRef,
        content,
        delivery,
        status: 'queued',
        ...(delivery === 'steer' && queueState.activeRunId ? { targetRunId: queueState.activeRunId } : {}),
        createdAt: now,
        updatedAt: now,
        position: queueState.items.length + items.length,
        revision: queueState.revision,
      }]);
      setPrompt('');
      setQueueNotice('');
      markQueueBusy('enqueue', true);
      try {
        const outcome = await enqueueQueuedMessage({
          scope,
          sessionId: conversationRef,
          content,
          delivery,
          ...(queueState.activeRunId ? { expectedRunId: queueState.activeRunId } : {}),
        });
        setOptimisticQueueItems((items) => items.filter((item) => item.itemId !== optimisticId));
        applyQueueOutcome(outcome);
      } catch (error) {
        setOptimisticQueueItems((items) => items.filter((item) => item.itemId !== optimisticId));
        setPrompt(content);
        setQueueNotice(error instanceof Error ? error.message : '队列提交失败');
      } finally {
        markQueueBusy('enqueue', false);
      }
      return;
    }
    const clientRequestId = crypto.randomUUID();
    setPrompt('');
    streamingRef.current = true;
    clientRequestIdRef.current = clientRequestId;
    runIdRef.current = null;
    dispatch({ type: 'begin', content, clientRequestId });
    const controller = new AbortController();
    const streamToken: ConversationStreamToken = { identity: conversationIdentity };
    activeStreamTokenRef.current = streamToken;
    controllerRef.current = controller;
    let settled = false;
    try {
      await streamConversation({
        scope,
        conversationRef,
        clientRequestId,
        prompt: content,
        signal: controller.signal,
        onEvent: (envelope) => handleStreamEvent(envelope, streamToken),
      });
      settled = true;
    } catch (error) {
      if (!controller.signal.aborted && activeStreamTokenRef.current === streamToken) {
        dispatch({ type: 'error', message: error instanceof Error ? error.message : '连接失败' });
      }
    } finally {
      if (activeStreamTokenRef.current === streamToken) {
        activeStreamTokenRef.current = null;
        controllerRef.current = null;
        if (settled) {
          clientRequestIdRef.current = null;
          runIdRef.current = null;
        }
        streamingRef.current = false;
      }
      await queryClient.invalidateQueries({ queryKey: ['conversations', scope] });
      await queryClient.invalidateQueries({ queryKey: ['conversation', scope] });
    }
  };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setQueueNotice('正在停止主 Agent 和全部子 Agent…');
    controllerRef.current?.abort('Session stop requested');
    try {
      if (conversationRef) {
        const result = await stopConversationSession(scope, conversationRef);
        agentDispatch({ type: 'replace', tree: result.agents });
        setAgentWakePolling(false);
        setQueueNotice(result.activeRun ? '停止命令已发送，正在等待运行退出。' : '已停止当前会话的全部运行。');
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['conversation', scope, conversationRef] }),
          queryClient.invalidateQueries({ queryKey: ['agents', scope, conversationRef] }),
          queryClient.invalidateQueries({ queryKey: ['conversations', scope] }),
        ]);
        return;
      }
      const runRef = runIdRef.current ?? clientRequestIdRef.current;
      if (!runRef) return;
      await stopConversationRun(scope, runRef);
      setQueueNotice('已发送停止命令。');
    } catch (error) {
      setQueueNotice(error instanceof Error ? error.message : '停止失败');
    } finally {
      setStopping(false);
    }
  };

  const promote = async (itemId: string) => {
    if (!conversationRef || !queueState.activeRunId || queueBusyRef.current.has(itemId)) return;
    markQueueBusy(itemId, true);
    setQueueNotice('');
    try {
      applyQueueOutcome(await promoteQueuedMessage({ scope, sessionId: conversationRef, itemId, expectedRunId: queueState.activeRunId }));
    } catch (error) {
      setQueueNotice(error instanceof Error ? error.message : '调整方向失败');
    } finally {
      markQueueBusy(itemId, false);
    }
  };

  const removeQueued = async (itemId: string) => {
    if (!conversationRef || queueBusyRef.current.has(itemId)) return;
    markQueueBusy(itemId, true);
    setQueueNotice('');
    try {
      applyQueueOutcome(await cancelQueuedMessage({ scope, sessionId: conversationRef, itemId }));
    } catch (error) {
      setQueueNotice(error instanceof Error ? error.message : '删除失败');
    } finally {
      markQueueBusy(itemId, false);
    }
  };

  const reorder = async (orderedItemIds: string[]) => {
    if (!conversationRef || queueBusyRef.current.has('reorder') || orderedItemIds.every((id, index) => queueState.items[index]?.itemId === id)) return;
    markQueueBusy('reorder', true);
    setQueueNotice('');
    try {
      const result = await reorderQueuedMessages({ scope, sessionId: conversationRef, orderedItemIds, expectedSessionRevision: queueState.revision });
      queueDispatch({ type: 'queue_reorder', orderedItemIds: result.orderedItemIds, revision: result.sessionRevision });
    } catch (error) {
      setQueueNotice(`${error instanceof Error ? error.message : '排序失败'}，已重新读取队列。`);
      await queryClient.invalidateQueries({ queryKey: ['conversation'] });
    } finally {
      markQueueBusy('reorder', false);
    }
  };

  const moveQueued = (itemId: string, direction: -1 | 1) => {
    const ids = queueState.items.map((item) => item.itemId);
    const index = ids.indexOf(itemId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void reorder(ids);
  };

  const dropQueued = (targetId: string) => {
    const sourceId = draggedQueueItem.current;
    draggedQueueItem.current = null;
    if (!sourceId || sourceId === targetId) return;
    const ids = queueState.items.map((item) => item.itemId).filter((id) => id !== sourceId);
    const target = ids.indexOf(targetId);
    ids.splice(target, 0, sourceId);
    void reorder(ids);
  };

  const resumeQueue = async () => {
    if (!conversationRef || streamingRef.current) return;
    const controller = new AbortController();
    const streamToken: ConversationStreamToken = { identity: conversationIdentity };
    activeStreamTokenRef.current = streamToken;
    controllerRef.current = controller;
    streamingRef.current = true;
    try {
      await streamQueueResume({ scope, sessionId: conversationRef, signal: controller.signal, onEvent: (envelope) => handleStreamEvent(envelope, streamToken) });
    } catch (error) {
      if (!controller.signal.aborted && activeStreamTokenRef.current === streamToken) {
        setQueueNotice(error instanceof Error ? error.message : '恢复队列失败');
      }
    } finally {
      if (activeStreamTokenRef.current === streamToken) {
        activeStreamTokenRef.current = null;
        controllerRef.current = null;
        streamingRef.current = false;
      }
      await queryClient.invalidateQueries({ queryKey: ['conversations', scope] });
      await queryClient.invalidateQueries({ queryKey: ['conversation'] });
    }
  };
  const timeline = useMemo(() => state.committedItems, [state.committedItems]);
  const visibleQueueItems = useMemo(() => [
    ...queueState.items.filter((item) => !presentedSteerIds.has(item.itemId)),
    ...optimisticQueueItems,
  ], [optimisticQueueItems, presentedSteerIds, queueState.items]);
  const timelineGroups = useMemo(() => groupConversationHistory(timeline), [timeline]);
  const agentGroups = useMemo(() => groupAgentTimeline(agentTree), [agentTree]);
  const activeAgentGroups = useMemo(() => state.activeRun
    ? agentGroups.filter((group) => group.sourceRunId === state.activeRun!.runId && group.sourceTurn !== undefined)
    : [], [agentGroups, state.activeRun]);
  const trailingGroups = useMemo(() => {
    const inlineAgentRunIds = new Set(timeline.flatMap((item) => item.kind === 'agent_activity' ? item.agentRunIds : []));
    const activeAgentRunIds = new Set(activeAgentGroups.flatMap((group) => group.agentRunIds));
    return agentGroups
      .map((group) => ({ ...group, agentRunIds: group.agentRunIds.filter((agentRunId) => !inlineAgentRunIds.has(agentRunId) && !activeAgentRunIds.has(agentRunId)) }))
      .filter((group) => group.agentRunIds.length > 0);
  }, [activeAgentGroups, agentGroups, timeline]);
  const openAgent = (agentId?: string) => { setSelectedAgentId(agentId); setAgentDrawerOpen(true); };
  const stopAgent = async (agentId: string) => {
    if (!conversationRef) return;
    try { await stopChildAgent(scope, conversationRef, agentId); }
    catch (error) { setQueueNotice(error instanceof Error ? error.message : '停止 Agent 失败'); }
  };
  const effectiveUsage = useMemo<ContextUsage>(() => {
    const contextWindowTokens = state.contextUsage.contextWindowTokens ?? meta.data?.model.contextWindow;
    const usedTokens = state.contextUsage.usedTokens ?? (state.committedItems.length === 0 ? 0 : undefined);
    return {
      ...state.contextUsage,
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(usedTokens !== undefined && contextWindowTokens ? { percentage: Number((usedTokens / contextWindowTokens * 100).toFixed(1)) } : {}),
      ...(state.contextUsage.source === 'unknown' && usedTokens === 0 ? { source: 'estimated' as const } : {}),
    };
  }, [meta.data?.model.contextWindow, state.contextUsage, state.committedItems.length]);
  const contextLevel = effectiveUsage.usedTokens !== undefined && effectiveUsage.hardLimitTokens !== undefined
    ? effectiveUsage.usedTokens >= effectiveUsage.hardLimitTokens
      ? 'danger'
      : effectiveUsage.targetTokens !== undefined && effectiveUsage.usedTokens >= effectiveUsage.targetTokens
        ? 'warning'
        : 'normal'
    : 'unknown';
  const scrollToBottom = () => {
    stickToBottom.current = true;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setAtBottom(true);
  };
  return (
    <AppShell scope={scope} conversationRef={conversationRef} title={loadingConversation ? '加载会话…' : state.title} status={state.status} agents={agentTree && agentTree.agents.length > 0 ? { running: agentTree.agents.filter((agent) => agent.status === 'running' || agent.status === 'stopping').length, total: agentTree.agents.length, onOpen: () => openAgent() } : undefined}>
      <div className="conversation-layout">
        <div
          className="conversation-scroll"
          ref={scrollRef}
          tabIndex={0}
          onWheel={(event) => { if (event.deltaY < 0) stickToBottom.current = false; }}
          onTouchMove={() => { stickToBottom.current = false; }}
          onKeyDown={(event) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) stickToBottom.current = false; }}
          onScroll={(event) => {
            const nearBottom = isTimelineNearBottom(event.currentTarget);
            stickToBottom.current = nearBottom;
            setAtBottom(nearBottom);
          }}
        >
          <div className="timeline" ref={timelineRef}>
          {loadingConversation ? (
            <div className="empty-conversation" role="status"><p>正在加载会话…</p></div>
          ) : timeline.length === 0 ? (
            <div className="empty-conversation">
              <h2>{scope.kind === 'general' ? '从一个问题开始' : '开始处理当前项目'}</h2>
              <p>{scope.kind === 'general' ? '这里不会启用项目文件与命令工具。加载项目后可以让 Agent 阅读和修改代码。' : '描述你的目标，DexCode 会在对话中展示每一步工具调用。'}</p>
            </div>
          ) : null}
          {timelineGroups.map((group) => {
            if (group.kind === 'item') return (
              <ConversationTimelineItem key={group.entry.item.id} item={group.entry.item} status={state.status} workspaceRef={workspaceRef} agentTree={agentTree} onOpenAgent={openAgent} onStopAgent={stopAgent} />
            );
            if (group.kind === 'execution_history') return (
              <ExecutionHistoryDisclosure key={`execution-${group.history[0]!.item.id}`} itemCount={group.history.length}>
                {group.history.map(({ item }) => (
                  <ConversationTimelineItem key={item.id} item={item} status={state.status} workspaceRef={workspaceRef} agentTree={agentTree} onOpenAgent={openAgent} onStopAgent={stopAgent} />
                ))}
              </ExecutionHistoryDisclosure>
            );
            return (
              <Fragment key={`response-${group.final.item.id}`}>
                {group.history.length > 0 ? (
                  <ExecutionHistoryDisclosure itemCount={group.history.length}>
                    {group.history.map(({ item }) => (
                      <ConversationTimelineItem key={item.id} item={item} status={state.status} workspaceRef={workspaceRef} agentTree={agentTree} onOpenAgent={openAgent} onStopAgent={stopAgent} />
                    ))}
                  </ExecutionHistoryDisclosure>
                ) : null}
                <ConversationTimelineItem item={group.final.item} status={state.status} workspaceRef={workspaceRef} agentTree={agentTree} onOpenAgent={openAgent} onStopAgent={stopAgent} />
              </Fragment>
            );
          })}
          {agentTree && trailingGroups.length > 0 ? (
            <ExecutionHistoryDisclosure itemCount={trailingGroups.length} label="子 Agent 执行过程">
              {trailingGroups.map((group) => <AgentActivityCard key={group.key} tree={agentTree} agentRunIds={group.agentRunIds} onOpen={openAgent} onStop={stopAgent} />)}
            </ExecutionHistoryDisclosure>
          ) : null}
          {state.activeRun ? <RunActivity run={state.activeRun} workspaceRef={workspaceRef} needsResync={state.needsResync} agentTree={agentTree} agentGroups={activeAgentGroups} onOpenAgent={openAgent} onStopAgent={(agentId) => void stopAgent(agentId)} /> : null}
          {state.streamError ? <div className="error-card"><strong>连接未完成</strong><span>{state.streamError}</span></div> : null}
          {state.terminal && state.terminal.status !== 'completed' ? (
            <div className="run-terminal-notice" role="status">
              <strong>{terminalTitle(state.terminal.status, state.terminal.reason)}</strong>
              <span>{state.terminal.error?.message ?? state.terminal.reason}</span>
            </div>
          ) : null}
          </div>
          {!atBottom ? <button className="back-to-bottom" onClick={scrollToBottom}><ArrowDown size={15} />回到底部</button> : null}
        </div>
        {visibleQueueItems.length > 0 || queueState.paused ? (
          <section className="queue-region" aria-label="等待处理的消息">
            <div className="queue-region-heading">
              <div><strong>后续消息</strong><span>{queueState.paused ? '已暂停' : `共 ${visibleQueueItems.length} 条`}</span></div>
              {queueState.paused && visibleQueueItems.length > 0 ? <button type="button" onClick={() => void resumeQueue()}>继续处理</button> : null}
            </div>
            {queueNotice ? <p className="queue-notice" role="status">{queueNotice}</p> : null}
            <div className="queue-list">
              {visibleQueueItems.map((item, index) => {
                const optimistic = item.itemId.startsWith('optimistic-');
                return (
                <QueuedMessageCard
                  key={item.itemId}
                  item={item}
                  busy={optimistic || queueBusy.has(item.itemId) || queueBusy.has('reorder')}
                  canPromote={!optimistic && (state.status === 'running' || state.status === 'waiting') && Boolean(queueState.activeRunId)}
                  canMoveUp={!optimistic && index > 0}
                  canMoveDown={!optimistic && index < visibleQueueItems.length - 1}
                  onPromote={() => void promote(item.itemId)}
                  onDelete={() => void removeQueued(item.itemId)}
                  onMove={(direction) => moveQueued(item.itemId, direction)}
                  onDragStart={() => { draggedQueueItem.current = item.itemId; }}
                  onDrop={() => dropQueued(item.itemId)}
                />
                );
              })}
            </div>
          </section>
        ) : queueNotice ? <p className="queue-notice standalone" role="status">{queueNotice}</p> : null}
        <form className="composer-wrap" onSubmit={(event) => void submit(event)}>
          <div className="composer">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="继续输入…"
            aria-label="发送消息"
            disabled={loadingConversation || stopping}
            rows={3}
          />
          <div className="composer-actions">
            {sessionHasActiveWork || stopping
              ? <>
                  <button type="button" className="send-button stop" onClick={() => void stop()} aria-label={stopping ? '正在停止' : '停止全部运行'} disabled={stopping}><Square size={14} fill="currentColor" /></button>
                  <button type="submit" className="send-button" disabled={!prompt.trim() || queueBusy.has('enqueue')} aria-label="发送后续消息"><ArrowUp size={18} /></button>
                </>
              : <button type="submit" className="send-button" disabled={!prompt.trim()} aria-label="发送"><ArrowUp size={18} /></button>}
          </div>
          <div className="composer-footer">
            <span className="model-name"><i />{meta.data?.model.displayName ?? '模型信息加载中'}</span>
            <label className="follow-up-setting">
              后续消息
              <select
                value={followUpBehavior}
                onChange={(event) => {
                  const value = event.target.value as FollowUpBehavior;
                  setFollowUpBehavior(value);
                  writeFollowUpBehavior(value);
                }}
              >
                <option value="queue">下一轮处理</option>
                <option value="steer">调整当前方向</option>
              </select>
            </label>
            <span className={`context-usage ${contextLevel}`}>
              <i><b style={{ width: `${Math.min(100, Math.max(0, effectiveUsage.percentage ?? 0))}%` }} /></i>
              <ContextLabel usage={effectiveUsage} running={state.status === 'running' || state.status === 'waiting'} />
            </span>
          </div>
          </div>
        </form>
      </div>
      {agentTree && conversationRef ? <AgentDrawer open={agentDrawerOpen} onOpenChange={setAgentDrawerOpen} tree={agentTree} scope={scope} sessionId={conversationRef} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} onStop={(agentId) => void stopAgent(agentId)} /> : null}
    </AppShell>
  );
}
