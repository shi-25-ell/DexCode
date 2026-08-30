import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Square } from 'lucide-react';
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiJson, getConversation, scopeWorkspaceRef, streamConversation } from '../api';
import { AppShell } from '../shell/app-shell';
import type { ContextUsage, ConversationItem, ConversationScope, ConversationSnapshot, StreamEvent, ToolPresentation } from '../types';
import { AssistantMessage } from './assistant-message';
import { assistantResponseCopyText, isCompleteAssistantResponse } from './response-boundary';
import { ToolCard } from './tool-card';
import { isTimelineNearBottom } from './scroll-follow';
import { UserMessage } from './user-message';

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
  | { type: 'usage'; usage: ContextUsage }
  | { type: 'status'; status: LiveState['status'] }
  | { type: 'approval'; item: Extract<ConversationItem, { kind: 'approval' }> }
  | { type: 'resolve'; approvalRef: string; answer: string }
  | { type: 'error'; message: string };

const initialState: LiveState = { items: [], contextUsage: { source: 'unknown' }, status: 'idle', title: '新会话' };

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
  if (usage.percentage === undefined) return <span>{running ? '上下文计算中' : '上下文未知'}</span>;
  const detail = usage.usedTokens !== undefined && usage.limitTokens !== undefined
    ? `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.limitTokens)} tokens`
    : '';
  return <span title={`${detail}${usage.source === 'estimated' ? ' · 估算' : ''}`}>上下文 {usage.percentage}%{usage.source === 'estimated' ? ' · 估算' : ''}</span>;
}

function ApprovalCard({ item, workspaceRef, onResolve }: {
  item: Extract<ConversationItem, { kind: 'approval' }>;
  workspaceRef?: string;
  onResolve: (answer: string) => void;
}) {
  const decide = async (answer: string) => {
    if (item.resolved) return;
    const command = item.approvalKind === 'command';
    await apiJson(command ? '/api/agent/command-confirm' : '/api/agent/confirm', {
      method: 'POST',
      workspaceRef,
      body: JSON.stringify(command ? { confirmId: item.approvalRef, decision: answer } : { confirmId: item.approvalRef, answer }),
    });
    onResolve(answer);
  };
  return (
    <section className="approval-card">
      <div><strong>{item.title}</strong>{item.target ? <code>{item.target}</code> : null}</div>
      <div className="approval-actions">
        {item.resolved ? <span>已选择：{item.resolved}</span> : item.options.map((option) => <button key={option} onClick={() => void decide(option)}>{option === 'deny' ? '拒绝' : option === 'allow_whitelist' ? '允许并加入白名单' : option === 'allow_once' || option === 'allow' ? '允许一次' : option}</button>)}
      </div>
    </section>
  );
}

export function ConversationPage({ scope, conversationRef }: { scope: ConversationScope; conversationRef?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(conversationReducer, initialState);
  const [prompt, setPrompt] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
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

  useEffect(() => {
    if (snapshot.data && !streamingRef.current) {
      dispatch({ type: 'hydrate', snapshot: snapshot.data });
    }
  }, [snapshot.data]);

  useEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    if (!conversationRef) dispatch({ type: 'hydrate', snapshot: { ref: 'draft', title: '新会话', state: 'idle', updatedAt: '', items: [], contextUsage: { source: 'unknown' } } });
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
    else if (event.type === 'context_usage') dispatch({ type: 'usage', usage: {
      ...(event.usedTokens !== undefined ? { usedTokens: event.usedTokens } : {}),
      ...(event.limitTokens !== undefined ? { limitTokens: event.limitTokens } : {}),
      ...(event.usedTokens !== undefined && event.limitTokens ? { percentage: Math.min(100, Math.round(event.usedTokens / event.limitTokens * 100)) } : {}),
      source: event.source,
      ...(event.asOfTurn ? { asOfTurn: event.asOfTurn } : {}),
    } });
    else if (event.type === 'task_status') dispatch({ type: 'status', status: event.status === 'waiting_confirm' ? 'waiting' : event.status === 'error' ? 'failed' : event.status === 'done' || event.status === 'aborted' ? 'idle' : 'running' });
    else if (event.type === 'confirm_request') dispatch({ type: 'approval', item: { id: `approval-${event.confirmId}`, kind: 'approval', approvalRef: event.confirmId, approvalKind: 'question', title: event.question, options: event.options?.length ? event.options : ['确认', '取消'] } });
    else if (event.type === 'command_confirm_request') dispatch({ type: 'approval', item: { id: `approval-${event.confirmId}`, kind: 'approval', approvalRef: event.confirmId, approvalKind: 'command', title: event.reason || '需要确认命令', target: event.command, options: ['allow_once', 'allow_whitelist', 'deny'] } });
    else if (event.type === 'error') dispatch({ type: 'error', message: event.message });
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = prompt.trim();
    if (!content || state.status === 'running' || state.status === 'waiting') return;
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

  const stop = () => controllerRef.current?.abort();
  const timeline = useMemo(() => state.items, [state.items]);
  const effectiveUsage = useMemo<ContextUsage>(() => {
    const limitTokens = state.contextUsage.limitTokens ?? meta.data?.model.contextWindow;
    const usedTokens = state.contextUsage.usedTokens ?? (state.items.length === 0 ? 0 : undefined);
    return {
      ...state.contextUsage,
      ...(limitTokens !== undefined ? { limitTokens } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(usedTokens !== undefined && limitTokens ? { percentage: Math.min(100, Math.round(usedTokens / limitTokens * 100)) } : {}),
      ...(state.contextUsage.source === 'unknown' && usedTokens === 0 ? { source: 'estimated' as const } : {}),
    };
  }, [meta.data?.model.contextWindow, state.contextUsage, state.items.length]);
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
            if (item.kind === 'approval') return <ApprovalCard key={item.id} item={item} workspaceRef={workspaceRef} onResolve={(answer) => dispatch({ type: 'resolve', approvalRef: item.approvalRef, answer })} />;
            return <div key={item.id} className="error-card"><strong>{item.title}</strong><span>{item.message}</span></div>;
          })}
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
            rows={3}
          />
          <div className="composer-actions">
            {state.status === 'running' || state.status === 'waiting'
              ? <button type="button" className="send-button stop" onClick={stop} aria-label="停止"><Square size={14} fill="currentColor" /></button>
              : <button type="submit" className="send-button" disabled={!prompt.trim()} aria-label="发送"><ArrowUp size={18} /></button>}
          </div>
          <div className="composer-footer">
            <span className="model-name"><i />{meta.data?.model.displayName ?? '模型信息加载中'}</span>
            <span className="context-usage"><i /><ContextLabel usage={effectiveUsage} running={state.status === 'running'} /></span>
          </div>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
