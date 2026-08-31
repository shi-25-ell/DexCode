import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Square } from 'lucide-react';
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiJson, cancelQueuedMessage, enqueueQueuedMessage, getConversation, promoteQueuedMessage, reorderQueuedMessages, scopeWorkspaceRef, stopConversationRun, streamConversation, streamQueueResume } from '../api';
import { AppShell } from '../shell/app-shell';
import type { ContextPresentation, ContextUsage, ConversationItem, ConversationScope, ConversationSnapshot, FollowUpBehavior, QueueMutationOutcome, StreamEvent, ToolPresentation } from '../types';
import { AssistantMessage } from './assistant-message';
import { assistantResponseCopyText, isCompleteAssistantResponse } from './response-boundary';
import { ToolCard } from './tool-card';
import { ContextCard } from './context-card';
import { isTimelineNearBottom } from './scroll-follow';
import { UserMessage } from './user-message';
import { initialQueueState, queueReducer } from './queue-reducer';
import { QueuedMessageCard } from './queued-message-card';
import { deliveryForFollowUp, readFollowUpBehavior, writeFollowUpBehavior } from '../settings/follow-up-behavior';

type LiveState = {
  items: ConversationItem[];
  contextUsage: ContextUsage;
  status: 'idle' | 'running' | 'waiting' | 'failed';
  title: string;
};

type Action =
  | { type: 'hydrate'; snapshot: ConversationSnapshot }
  | { type: 'submit'; content: string }
  | { type: 'chunk'; content: string }
  | { type: 'tool'; tool: ToolPresentation }
  | { type: 'context'; context: ContextPresentation }
  | { type: 'usage'; usage: ContextUsage }
  | { type: 'status'; status: LiveState['status'] }
  | { type: 'approval'; item: Extract<ConversationItem, { kind: 'approval' }> }
  | { type: 'resolve'; approvalRef: string; answer: string }
  | { type: 'error'; message: string };

const initialState: LiveState = { items: [], contextUsage: { source: 'unknown', timing: 'next_request' }, status: 'idle', title: '新会话' };

function shortTitle(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ');
  return Array.from(normalized).length > 36 ? `${Array.from(normalized).slice(0, 36).join('')}…` : normalized;
}

export function conversationReducer(state: LiveState, action: Action): LiveState {
  if (action.type === 'hydrate') return { items: action.snapshot.items, contextUsage: action.snapshot.contextUsage, status: action.snapshot.state, title: action.snapshot.title };
  if (action.type === 'submit') return {
    ...state,
    title: state.items.length === 0 ? shortTitle(action.content) : state.title,
    status: 'running',
    items: [...state.items, { id: `local-user-${crypto.randomUUID()}`, kind: 'user', content: action.content }],
  };
  if (action.type === 'chunk') {
    const items = [...state.items];
    const last = items.at(-1);
    if (last?.kind === 'assistant' && last.id.startsWith('live-assistant-')) items[items.length - 1] = { ...last, content: last.content + action.content };
    else items.push({ id: `live-assistant-${crypto.randomUUID()}`, kind: 'assistant', content: action.content });
    return { ...state, items };
  }
  if (action.type === 'tool') {
    const existing = state.items.findIndex((item) => item.kind === 'tool' && item.tool.callRef === action.tool.callRef);
    if (existing < 0) return { ...state, items: [...state.items, { id: `tool-${action.tool.callRef}`, kind: 'tool', tool: action.tool }] };
    const items = [...state.items];
    items[existing] = { id: `tool-${action.tool.callRef}`, kind: 'tool', tool: action.tool };
    return { ...state, items };
  }
  if (action.type === 'context') {
    const existing = state.items.findIndex((item) => item.kind === 'context' && item.context.operationRef === action.context.operationRef);
    const next = { id: `context-${action.context.operationRef}`, kind: 'context' as const, context: action.context };
    if (existing < 0) return { ...state, items: [...state.items, next] };
    const items = [...state.items];
    items[existing] = next;
    return { ...state, items };
  }
  if (action.type === 'usage') return { ...state, contextUsage: action.usage };
  if (action.type === 'status') return { ...state, status: action.status };
  if (action.type === 'approval') return { ...state, status: 'waiting', items: [...state.items, action.item] };
  if (action.type === 'resolve') return {
    ...state,
    status: 'running',
    items: state.items.map((item) => item.kind === 'approval' && item.approvalRef === action.approvalRef ? { ...item, resolved: action.answer } : item),
  };
  return { ...state, status: 'failed', items: [...state.items, { id: `error-${crypto.randomUUID()}`, kind: 'error', title: '连接未完成', message: action.message }] };
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
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

function approvalLabel(value: string): string {
  if (value === 'deny') return '已拒绝';
  if (value === 'allow_whitelist') return '已加入白名单';
  if (value === 'allow_once' || value === 'allow') return '允许一次';
  return value;
}

export function ApprovalCard({ item, workspaceRef, onResolve }: {
  item: Extract<ConversationItem, { kind: 'approval' }>;
  workspaceRef?: string;
  onResolve: (answer: string) => void;
}) {
  const decide = async (answer: string) => {
    if (item.resolved) return;
    const tool = item.approvalKind === 'tool';
    const command = item.approvalKind === 'command';
    await apiJson(tool ? '/api/agent/approval' : command ? '/api/agent/command-confirm' : '/api/agent/confirm', {
      method: 'POST',
      workspaceRef,
      body: JSON.stringify(tool
        ? { approvalId: item.approvalRef, decision: answer, fingerprint: item.fingerprint }
        : command ? { confirmId: item.approvalRef, decision: answer } : { confirmId: item.approvalRef, answer }),
    });
    onResolve(answer);
  };
  return (
    <section className="approval-card">
      <div><strong>{item.title}</strong>{item.target ? <code>{item.target}</code> : null}</div>
      {item.reason ? <p>{item.reason}</p> : null}
      <div className="approval-actions">
        {item.resolved ? <span>{approvalLabel(item.resolved)}</span> : item.options.map((option) => <button key={option} onClick={() => void decide(option)}>{option === 'deny' ? '拒绝' : option === 'allow_whitelist' ? '允许并加入白名单' : option === 'allow_once' || option === 'allow' ? '允许一次' : option}</button>)}
      </div>
    </section>
  );
}

export function ConversationPage({ scope, conversationRef }: { scope: ConversationScope; conversationRef?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(conversationReducer, initialState);
  const [queueState, queueDispatch] = useReducer(queueReducer, initialQueueState);
  const [prompt, setPrompt] = useState('');
  const [followUpBehavior, setFollowUpBehavior] = useState<FollowUpBehavior>(() => readFollowUpBehavior());
  const [queueBusy, setQueueBusy] = useState<Set<string>>(() => new Set());
  const [queueNotice, setQueueNotice] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const streamingRef = useRef(false);
  const draggedQueueItem = useRef<string | null>(null);
  const queueBusyRef = useRef<Set<string>>(new Set());
  const workspaceRef = scopeWorkspaceRef(scope);
  const snapshot = useQuery({
    queryKey: ['conversation', scope, conversationRef],
    queryFn: () => getConversation(scope, conversationRef!),
    enabled: Boolean(conversationRef),
  });
  const meta = useQuery({
    queryKey: ['meta', workspaceRef],
    queryFn: () => apiJson<{ model: { displayName: string; contextWindow?: number } }>('/api/meta', { workspaceRef }),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (snapshot.data && !streamingRef.current) {
      dispatch({ type: 'hydrate', snapshot: snapshot.data });
      queueDispatch({
        type: 'queue_snapshot',
        items: snapshot.data.queuedItems,
        revision: snapshot.data.revision,
        paused: snapshot.data.queuePaused,
        ...(snapshot.data.activeRun ? { activeRunId: snapshot.data.activeRun.runId } : {}),
      });
    }
  }, [snapshot.data]);

  useEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    if (!conversationRef) {
      dispatch({ type: 'hydrate', snapshot: { ref: 'draft', title: '新会话', state: 'idle', updatedAt: '', items: [], queuedItems: [], queuePaused: false, revision: 0, contextUsage: { source: 'unknown', timing: 'next_request' } } });
      queueDispatch({ type: 'queue_snapshot', items: [], revision: 0, paused: false });
    }
  }, [conversationRef, scope.kind, scope.kind === 'workspace' ? scope.workspaceRef : 'general']);

  useLayoutEffect(() => {
    if (!stickToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = element.scrollHeight;
      setAtBottom(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [state.items]);

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

  const handleStreamEvent = (event: StreamEvent) => {
    if (event.type === 'session' && event.isNew) {
      const next = scope.kind === 'general'
        ? `/c/${encodeURIComponent(event.sessionId)}`
        : `/w/${encodeURIComponent(scope.workspaceRef)}/c/${encodeURIComponent(event.sessionId)}`;
      navigate(next, { replace: true });
    } else if (event.type === 'chunk') dispatch({ type: 'chunk', content: event.chunk });
    else if (event.type === 'tool_view') dispatch({ type: 'tool', tool: event.presentation });
    else if (event.type === 'context_usage') {
      const { type: _type, ...usage } = event;
      dispatch({ type: 'usage', usage });
    }
    else if (event.type === 'context_activity') dispatch({ type: 'context', context: event.presentation });
    else if (event.type === 'task_status') {
      dispatch({ type: 'status', status: event.status === 'waiting_confirm' ? 'waiting' : event.status === 'error' ? 'failed' : event.status === 'done' || event.status === 'aborted' ? 'idle' : 'running' });
      if (event.status === 'done' || event.status === 'aborted' || event.status === 'error') queueDispatch({ type: 'run_terminal' });
    }
    else if (event.type === 'confirm_request') dispatch({ type: 'approval', item: { id: `approval-${event.confirmId}`, kind: 'approval', approvalRef: event.confirmId, approvalKind: 'question', title: event.question, options: event.options?.length ? event.options : ['确认', '取消'] } });
    else if (event.type === 'command_confirm_request') dispatch({ type: 'approval', item: { id: `approval-${event.confirmId}`, kind: 'approval', approvalRef: event.confirmId, approvalKind: 'command', title: event.reason || '需要确认命令', target: event.command, options: ['allow_once', 'allow_whitelist', 'deny'] } });
    else if (event.type === 'approval_request') dispatch({ type: 'approval', item: { id: `approval-${event.approvalId}`, kind: 'approval', approvalRef: event.approvalId, approvalKind: 'tool', toolName: event.toolName, effect: event.effect, title: event.title, target: event.target, reason: event.reason, fingerprint: event.fingerprint, options: event.options } });
    else if (event.type === 'error') dispatch({ type: 'error', message: event.message });
    else if (event.type === 'queue_item_added' || event.type === 'queue_item_updated') queueDispatch({ type: 'queue_upsert', item: event.item, revision: event.sessionRevision });
    else if (event.type === 'queue_item_removed') queueDispatch({ type: 'queue_remove', itemId: event.itemId, revision: event.sessionRevision });
    else if (event.type === 'queue_reordered') queueDispatch({ type: 'queue_reorder', orderedItemIds: event.orderedItemIds, revision: event.sessionRevision });
    else if (event.type === 'run_started') queueDispatch({ type: 'run_started', runId: event.runId, ...(event.sourceItemId ? { sourceItemId: event.sourceItemId } : {}) });
    else if (event.type === 'run_chain_paused') queueDispatch({ type: 'run_chain_paused' });
    else if (event.type === 'context_refresh_failed') setQueueNotice(`方向已更新，但上下文刷新失败：${event.message}`);
  };

  const applyQueueOutcome = (outcome: QueueMutationOutcome) => {
    if (outcome.outcome === 'queued' || outcome.outcome === 'steered' || outcome.outcome === 'remained_queued') {
      queueDispatch({ type: 'queue_upsert', item: outcome.item, revision: outcome.sessionRevision });
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
    if ((state.status === 'running' || state.status === 'waiting') && conversationRef) {
      setPrompt('');
      setQueueNotice('');
      markQueueBusy('enqueue', true);
      try {
        const outcome = await enqueueQueuedMessage({
          scope,
          sessionId: conversationRef,
          content,
          delivery: deliveryForFollowUp(followUpBehavior),
          ...(queueState.activeRunId ? { expectedRunId: queueState.activeRunId } : {}),
        });
        applyQueueOutcome(outcome);
      } catch (error) {
        setPrompt(content);
        setQueueNotice(error instanceof Error ? error.message : '队列提交失败');
      } finally {
        markQueueBusy('enqueue', false);
      }
      return;
    }
    if (state.status === 'running' || state.status === 'waiting') return;
    setPrompt('');
    streamingRef.current = true;
    dispatch({ type: 'submit', content });
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await streamConversation({
        scope,
        conversationRef,
        clientRequestId: crypto.randomUUID(),
        prompt: content,
        signal: controller.signal,
        onEvent: handleStreamEvent,
      });
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: 'error', message: error instanceof Error ? error.message : '连接失败' });
    } finally {
      controllerRef.current = null;
      streamingRef.current = false;
      dispatch({ type: 'status', status: 'idle' });
      await queryClient.invalidateQueries({ queryKey: ['conversations', scope] });
      await queryClient.invalidateQueries({ queryKey: ['conversation'] });
    }
  };

  const stop = async () => {
    if (!queueState.activeRunId) {
      controllerRef.current?.abort();
      return;
    }
    try {
      await stopConversationRun(scope, queueState.activeRunId);
    } catch (error) {
      setQueueNotice(error instanceof Error ? error.message : '停止失败');
      controllerRef.current?.abort();
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
    controllerRef.current = controller;
    streamingRef.current = true;
    dispatch({ type: 'status', status: 'running' });
    try {
      await streamQueueResume({ scope, sessionId: conversationRef, signal: controller.signal, onEvent: handleStreamEvent });
    } catch (error) {
      if (!controller.signal.aborted) setQueueNotice(error instanceof Error ? error.message : '恢复队列失败');
    } finally {
      controllerRef.current = null;
      streamingRef.current = false;
      dispatch({ type: 'status', status: 'idle' });
      await queryClient.invalidateQueries({ queryKey: ['conversations', scope] });
      await queryClient.invalidateQueries({ queryKey: ['conversation'] });
    }
  };
  const timeline = useMemo(() => state.items, [state.items]);
  const effectiveUsage = useMemo<ContextUsage>(() => {
    const contextWindowTokens = state.contextUsage.contextWindowTokens ?? meta.data?.model.contextWindow;
    const usedTokens = state.contextUsage.usedTokens ?? (state.items.length === 0 ? 0 : undefined);
    return {
      ...state.contextUsage,
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(usedTokens !== undefined && contextWindowTokens ? { percentage: Number((usedTokens / contextWindowTokens * 100).toFixed(1)) } : {}),
      ...(state.contextUsage.source === 'unknown' && usedTokens === 0 ? { source: 'estimated' as const } : {}),
    };
  }, [meta.data?.model.contextWindow, state.contextUsage, state.items.length]);
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
    <AppShell scope={scope} conversationRef={conversationRef} title={state.title} status={state.status}>
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
          {timeline.length === 0 ? (
            <div className="empty-conversation">
              <h2>{scope.kind === 'general' ? '从一个问题开始' : '开始处理当前项目'}</h2>
              <p>{scope.kind === 'general' ? '这里不会启用项目文件与命令工具。加载项目后可以让 Agent 阅读和修改代码。' : '描述你的目标，DexCode 会在对话中展示每一步工具调用。'}</p>
            </div>
          ) : null}
          {timeline.map((item, index) => {
            if (item.kind === 'user') return <UserMessage key={item.id} content={item.content} />;
            if (item.kind === 'assistant') {
              const showCopy = isCompleteAssistantResponse(timeline, index, state.status);
              return <AssistantMessage key={item.id} content={item.content} copyContent={showCopy ? assistantResponseCopyText(timeline, index) : item.content} showCopy={showCopy} />;
            }
            if (item.kind === 'tool') return <ToolCard key={item.id} tool={item.tool} />;
            if (item.kind === 'context') return <ContextCard key={item.id} context={item.context} />;
            if (item.kind === 'approval') return <ApprovalCard key={item.id} item={item} workspaceRef={workspaceRef} onResolve={(answer) => dispatch({ type: 'resolve', approvalRef: item.approvalRef, answer })} />;
            return <div key={item.id} className="error-card"><strong>{item.title}</strong><span>{item.message}</span></div>;
          })}
          </div>
          {!atBottom ? <button className="back-to-bottom" onClick={scrollToBottom}><ArrowDown size={15} />回到底部</button> : null}
        </div>
        {queueState.items.length > 0 || queueState.paused ? (
          <section className="queue-region" aria-label="等待处理的消息">
            <div className="queue-region-heading">
              <div><strong>后续消息</strong><span>{queueState.paused ? '已暂停' : `共 ${queueState.items.length} 条`}</span></div>
              {queueState.paused && queueState.items.length > 0 ? <button type="button" onClick={() => void resumeQueue()}>继续处理</button> : null}
            </div>
            {queueNotice ? <p className="queue-notice" role="status">{queueNotice}</p> : null}
            <div className="queue-list">
              {queueState.items.map((item, index) => (
                <QueuedMessageCard
                  key={item.itemId}
                  item={item}
                  busy={queueBusy.has(item.itemId) || queueBusy.has('reorder')}
                  canPromote={(state.status === 'running' || state.status === 'waiting') && Boolean(queueState.activeRunId)}
                  canMoveUp={index > 0}
                  canMoveDown={index < queueState.items.length - 1}
                  onPromote={() => void promote(item.itemId)}
                  onDelete={() => void removeQueued(item.itemId)}
                  onMove={(direction) => moveQueued(item.itemId, direction)}
                  onDragStart={() => { draggedQueueItem.current = item.itemId; }}
                  onDrop={() => dropQueued(item.itemId)}
                />
              ))}
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
            rows={3}
          />
          <div className="composer-actions">
            {state.status === 'running' || state.status === 'waiting'
              ? <>
                  <button type="button" className="send-button stop" onClick={() => void stop()} aria-label="停止"><Square size={14} fill="currentColor" /></button>
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
              <ContextLabel usage={effectiveUsage} running={state.status === 'running'} />
            </span>
          </div>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
