import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Square } from 'lucide-react';
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunEventEnvelope } from '../../../../packages/run-protocol/contracts';
import { apiJson, getConversation, scopeWorkspaceRef, stopConversationRun, streamConversation } from '../api';
import { AppShell } from '../shell/app-shell';
import type { ContextUsage, ConversationScope, ConversationSnapshot } from '../types';
import { ApprovalCard } from './approval-card';
import { AssistantMessage } from './assistant-message';
import { assistantResponseCopyText, isCompleteAssistantResponse } from './response-boundary';
import { ToolCard } from './tool-card';
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

type PageAction =
  | { type: 'hydrate'; snapshot: ConversationSnapshot }
  | { type: 'begin'; content: string; clientRequestId: string }
  | { type: 'run_event'; event: RunEventEnvelope }
  | { type: 'error'; message: string };

const emptySnapshot: ConversationSnapshot = {
  ref: 'draft',
  title: '新会话',
  state: 'idle',
  updatedAt: '',
  revision: 0,
  items: [],
  contextUsage: { source: 'unknown', timing: 'next_request' },
};

function pageReducer(state: RunPresentation, action: PageAction): RunPresentation {
  if (action.type === 'hydrate') return hydrateRunPresentation(action.snapshot);
  if (action.type === 'begin') return beginRunPresentation(state, action);
  if (action.type === 'run_event') return reduceRunEvent(state, action.event);
  return failRunPresentation(state, action.message);
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

export function ConversationPage({ scope, conversationRef }: { scope: ConversationScope; conversationRef?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(pageReducer, emptySnapshot, hydrateRunPresentation);
  const [prompt, setPrompt] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const clientRequestIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const streamingRef = useRef(false);
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
  const loadingConversation = Boolean(conversationRef && !snapshot.data && snapshot.isPending);

  useEffect(() => {
    if (snapshot.data && !streamingRef.current) {
      dispatch({ type: 'hydrate', snapshot: snapshot.data });
    }
  }, [snapshot.data]);

  useEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    if (!conversationRef) dispatch({ type: 'hydrate', snapshot: emptySnapshot });
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

  const handleStreamEvent = (envelope: RunEventEnvelope) => {
    runIdRef.current = envelope.runId;
    const event = envelope.event;
    if (event.type === 'run_started' && event.isNew) {
      const next = scope.kind === 'general'
        ? `/c/${encodeURIComponent(event.sessionId)}`
        : `/w/${encodeURIComponent(scope.workspaceRef)}/c/${encodeURIComponent(event.sessionId)}`;
      navigate(next, { replace: true });
    }
    if (event.type === 'run_finished') {
      queryClient.setQueryData<ConversationSnapshot>(['conversation', scope, event.conversation.ref], event.conversation as ConversationSnapshot);
    }
    dispatch({ type: 'run_event', event: envelope });
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = prompt.trim();
    if (!content || state.activeRun || loadingConversation) return;
    const clientRequestId = crypto.randomUUID();
    setPrompt('');
    streamingRef.current = true;
    clientRequestIdRef.current = clientRequestId;
    runIdRef.current = null;
    dispatch({ type: 'begin', content, clientRequestId });
    const controller = new AbortController();
    controllerRef.current = controller;
    let settled = false;
    try {
      await streamConversation({
        scope,
        conversationRef,
        clientRequestId,
        prompt: content,
        signal: controller.signal,
        onEvent: handleStreamEvent,
      });
      settled = true;
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: 'error', message: error instanceof Error ? error.message : '连接失败' });
    } finally {
      controllerRef.current = null;
      if (settled) {
        clientRequestIdRef.current = null;
        runIdRef.current = null;
      }
      streamingRef.current = false;
      await queryClient.invalidateQueries({ queryKey: ['conversations', scope] });
    }
  };

  const stop = async () => {
    const runRef = runIdRef.current ?? clientRequestIdRef.current;
    if (!runRef) return;
    try {
      await stopConversationRun(runRef);
    } catch (error) {
      if (state.activeRun) dispatch({ type: 'error', message: error instanceof Error ? error.message : '停止运行失败' });
    }
  };
  const timeline = useMemo(() => state.committedItems, [state.committedItems]);
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
    <AppShell scope={scope} conversationRef={conversationRef} title={loadingConversation ? '加载会话…' : state.title} status={state.status}>
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
          {timeline.map((item, index) => {
            if (item.kind === 'user') return <UserMessage key={item.id} content={item.content} />;
            if (item.kind === 'assistant') {
              const showCopy = isCompleteAssistantResponse(item, state.status);
              return <AssistantMessage key={item.id} content={item.content} copyContent={showCopy ? assistantResponseCopyText(timeline, index) : item.content} showCopy={showCopy} />;
            }
            if (item.kind === 'tool') return <ToolCard key={item.id} tool={item.tool} />;
            if (item.kind === 'context') return <ContextCard key={item.id} context={item.context} />;
            if (item.kind === 'approval') return <ApprovalCard key={item.id} item={item} workspaceRef={workspaceRef} />;
            return <div key={item.id} className="error-card"><strong>{item.title}</strong><span>{item.message}</span></div>;
          })}
          {state.activeRun ? <RunActivity run={state.activeRun} workspaceRef={workspaceRef} needsResync={state.needsResync} /> : null}
          {state.streamError ? <div className="error-card"><strong>连接未完成</strong><span>{state.streamError}</span></div> : null}
          {state.terminal && state.terminal.status !== 'completed' ? (
            <div className="run-terminal-notice" role="status">
              <strong>{state.terminal.status === 'aborted' ? '运行已取消' : state.terminal.status === 'limited' ? '运行达到限制' : '运行未完成'}</strong>
              <span>{state.terminal.error?.message ?? state.terminal.reason}</span>
            </div>
          ) : null}
          </div>
          {!atBottom ? <button className="back-to-bottom" onClick={scrollToBottom}><ArrowDown size={15} />回到底部</button> : null}
        </div>
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
            disabled={loadingConversation}
            rows={3}
          />
          <div className="composer-actions">
            {state.activeRun
              ? <button type="button" className="send-button stop" onClick={() => void stop()} aria-label="停止"><Square size={14} fill="currentColor" /></button>
              : <button type="submit" className="send-button" disabled={loadingConversation || !prompt.trim()} aria-label="发送"><ArrowUp size={18} /></button>}
          </div>
          <div className="composer-footer">
            <span className="model-name"><i />{meta.data?.model.displayName ?? '模型信息加载中'}</span>
            <span className={`context-usage ${contextLevel}`}>
              <i><b style={{ width: `${Math.min(100, Math.max(0, effectiveUsage.percentage ?? 0))}%` }} /></i>
              <ContextLabel usage={effectiveUsage} running={state.status === 'running' || state.status === 'waiting'} />
            </span>
          </div>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
