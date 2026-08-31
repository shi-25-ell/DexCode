import * as Dialog from '@radix-ui/react-dialog';
import * as Collapsible from '@radix-ui/react-collapsible';
import { Bot, ChevronDown, ChevronRight, LoaderCircle, Square, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getAgentDetail } from '../api';
import type { AgentDetail, AgentRecordView, AgentRunView, AgentToolView, AgentTreeSnapshot, ConversationScope, ToolPresentation } from '../types';
import { AssistantMessage } from './assistant-message';
import { ExecutionHistoryDisclosure } from './execution-history';
import { ToolCard } from './tool-card';

function runFor(tree: AgentTreeSnapshot, agent: AgentRecordView) {
  return tree.runs.find((run) => run.agentRunId === (agent.currentRunId ?? agent.lastRunId));
}

function statusLabel(tree: AgentTreeSnapshot, agent: AgentRecordView): string {
  if (agent.status === 'running') return '运行中';
  if (agent.status === 'stopping') return '正在停止';
  const status = runFor(tree, agent)?.status;
  if (status === 'completed') return '已完成';
  if (status === 'interrupted') return '已停止 · 可继续';
  if (status === 'failed') return '未完成';
  if (status === 'limited') return '达到限制';
  return '空闲';
}

function runStatusLabel(run: AgentRunView, agent: AgentRecordView): string {
  if (run.status === 'running') return agent.status === 'stopping' && agent.currentRunId === run.agentRunId ? '正在停止' : '运行中';
  if (run.status === 'completed') return '已完成';
  if (run.status === 'interrupted') return '已停止 · 可继续';
  if (run.status === 'failed') return '未完成';
  return '达到限制';
}

function durationLabel(startedAt: string, completedAt: string | undefined, now: number): string {
  const elapsed = Math.max(0, Math.floor(((completedAt ? Date.parse(completedAt) : now) - Date.parse(startedAt)) / 1_000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function AgentRunMeta({ run }: { run: AgentRunView }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run.status]);
  const tokens = run.usage?.totalTokens ?? run.result?.usage?.totalTokens;
  return <>{durationLabel(run.startedAt, run.completedAt, now)}{tokens !== undefined ? ` · ${tokens.toLocaleString('zh-CN')} tok` : ''}</>;
}

export function AgentActivityCard({ tree, agentRunIds, onOpen, onStop }: {
  tree: AgentTreeSnapshot; agentRunIds: string[]; onOpen(agentId: string): void; onStop(agentId: string): void;
}) {
  const entries = agentRunIds.flatMap((id) => {
    const run = tree.runs.find((candidate) => candidate.agentRunId === id);
    const agent = run ? tree.agents.find((candidate) => candidate.agentId === run.agentId) : undefined;
    return run && agent ? [{ run, agent }] : [];
  });
  if (entries.length === 0) return null;
  return (
    <section className="agent-activity-card">
      <div className="agent-card-heading"><span><Bot size={17} />{entries.length > 1 ? '并行任务' : '子 Agent'}</span><small>{entries.length} 次运行</small></div>
      {entries.map(({ agent, run }) => {
        const running = run.status === 'running' && agent.currentRunId === run.agentRunId;
        return (
        <div className="agent-card-row" key={run.agentRunId}>
          <button className="agent-card-main" onClick={() => onOpen(agent.agentId)}>
            <i className={`agent-dot ${running ? agent.status : 'idle'}`} />
            <span><strong>{agent.name}</strong><small>{run.input}</small></span>
            <em>{runStatusLabel(run, agent)} · <AgentRunMeta run={run} /></em><ChevronRight size={15} />
          </button>
          {running ? <button className="agent-stop" disabled={agent.status === 'stopping'} onClick={() => onStop(agent.agentId)} aria-label={`停止 ${agent.name}`}><Square size={12} fill="currentColor" /></button> : null}
        </div>
      );})}
    </section>
  );
}

export function AgentInvocationPlaceholder() {
  return (
    <section className="agent-activity-card" aria-label="子 Agent 正在启动">
      <div className="agent-card-heading"><span><Bot size={17} />子 Agent</span><small>正在启动…</small></div>
    </section>
  );
}

function fallbackToolPresentation(tool: AgentToolView | undefined, input: { callId: string; name: string; output?: string }): ToolPresentation {
  const running = tool?.status === 'running';
  return {
    callRef: input.callId,
    toolName: tool?.name ?? input.name,
    category: 'other',
    name: tool?.name ?? input.name,
    status: running ? 'running' : 'succeeded',
    summary: running ? '正在执行…' : '执行完成',
    ...(input.output ? { rawOutput: input.output } : {}),
  };
}

type AgentTranscriptEntry =
  | { key: string; kind: 'assistant'; content: string }
  | { key: string; kind: 'tool'; tool: ToolPresentation };

type AgentTranscriptSegment = {
  key: string;
  prompt?: string;
  run?: AgentRunView;
  entries: AgentTranscriptEntry[];
};

function buildAgentTranscriptSegments(detail: AgentDetail): AgentTranscriptSegment[] {
  const tools = new Map((detail.tools ?? []).map((tool) => [tool.callId, tool]));
  const renderedTools = new Set<string>();
  const segments: AgentTranscriptSegment[] = [];
  let runIndex = 0;
  let current: AgentTranscriptSegment = { key: 'agent-transcript-orphan', entries: [] };
  const flush = () => {
    if (current.prompt !== undefined || current.entries.length > 0) segments.push(current);
  };
  const appendTool = (callId: string, name: string, output?: string) => {
    if (renderedTools.has(callId)) return;
    renderedTools.add(callId);
    const tool = tools.get(callId);
    current.entries.push({
      key: `tool-${callId}`,
      kind: 'tool',
      tool: tool?.presentation ?? fallbackToolPresentation(tool, { callId, name, ...(output ? { output } : {}) }),
    });
  };

  detail.messages.forEach((message, messageIndex) => {
    if (message.role === 'user') {
      flush();
      const run = detail.runs[runIndex++];
      current = {
        key: run?.agentRunId ?? `agent-transcript-run-${messageIndex}`,
        prompt: message.content,
        ...(run ? { run } : {}),
        entries: [],
      };
      return;
    }
    if (message.role === 'assistant') {
      if (message.content?.trim()) current.entries.push({ key: `assistant-${messageIndex}`, kind: 'assistant', content: message.content });
      for (const call of message.tool_calls ?? []) appendTool(call.id, call.function.name);
      return;
    }
    if (message.role === 'tool') appendTool(message.tool_call_id, message.name, message.content);
  });
  for (const tool of detail.tools ?? []) appendTool(tool.callId, tool.name);
  flush();
  return segments;
}

function finalAssistantIndex(segment: AgentTranscriptSegment): number {
  if (segment.run?.status !== 'completed') return -1;
  const expected = segment.run.result?.finalContent.trim();
  let fallback = -1;
  for (let index = segment.entries.length - 1; index >= 0; index -= 1) {
    const entry = segment.entries[index];
    if (entry?.kind !== 'assistant') continue;
    if (fallback < 0) fallback = index;
    if (expected && entry.content.trim() === expected) return index;
  }
  return fallback;
}

function AgentParentPrompt({ content }: { content: string }) {
  return (
    <Collapsible.Root className="agent-parent-prompt">
      <Collapsible.Trigger><span>父 Agent 指令</span><ChevronDown className="chevron" size={15} /></Collapsible.Trigger>
      <Collapsible.Content><pre>{content}</pre></Collapsible.Content>
    </Collapsible.Root>
  );
}

function AgentTranscriptEntryView({ entry, showCopy = false }: { entry: AgentTranscriptEntry; showCopy?: boolean }) {
  if (entry.kind === 'assistant') return <AssistantMessage content={entry.content} showCopy={showCopy} />;
  return <ToolCard tool={entry.tool} />;
}

function AgentTranscriptSegmentView({ segment }: { segment: AgentTranscriptSegment }) {
  const finalIndex = finalAssistantIndex(segment);
  const final = finalIndex >= 0 ? segment.entries[finalIndex] : undefined;
  const history = finalIndex >= 0 ? segment.entries.filter((_entry, index) => index !== finalIndex) : [];
  return (
    <section className="agent-transcript-run">
      {segment.prompt !== undefined ? <AgentParentPrompt content={segment.prompt} /> : null}
      {final?.kind === 'assistant' ? (
        <>
          {history.length > 0 ? (
            <ExecutionHistoryDisclosure itemCount={history.length}>
              {history.map((entry) => <AgentTranscriptEntryView key={entry.key} entry={entry} />)}
            </ExecutionHistoryDisclosure>
          ) : null}
          <AgentTranscriptEntryView entry={final} showCopy />
        </>
      ) : segment.entries.map((entry) => <AgentTranscriptEntryView key={entry.key} entry={entry} />)}
    </section>
  );
}

export function AgentTranscript({ detail }: { detail: AgentDetail }) {
  const detailTools = detail.tools ?? [];
  const hasRunningTool = detailTools.some((tool) => tool.status === 'running');
  const activityLabel = detail.agent.status === 'stopping'
    ? '正在停止…'
    : detail.agent.status === 'running' && !hasRunningTool
      ? '正在思考…'
      : undefined;
  const segments = useMemo(() => buildAgentTranscriptSegments(detail), [detail]);

  return (
    <div className="agent-transcript-stream">
      {segments.length > 0 ? segments.map((segment) => <AgentTranscriptSegmentView key={segment.key} segment={segment} />) : activityLabel ? null : <p className="agent-transcript-empty">尚无对话内容</p>}
      {activityLabel ? <div className="agent-thinking" role="status"><LoaderCircle size={15} />{activityLabel}</div> : null}
    </div>
  );
}

export function AgentDrawer({ open, onOpenChange, tree, scope, sessionId, selectedAgentId, onSelect, onStop }: {
  open: boolean; onOpenChange(open: boolean): void; tree: AgentTreeSnapshot; scope: ConversationScope; sessionId: string;
  selectedAgentId?: string; onSelect(agentId?: string): void; onStop(agentId: string): void;
}) {
  const selectedAgentRunning = Boolean(selectedAgentId && tree.agents.some((agent) => agent.agentId === selectedAgentId && (agent.status === 'running' || agent.status === 'stopping')));
  const detail = useQuery({
    queryKey: ['agent-detail', scope, sessionId, selectedAgentId],
    queryFn: () => getAgentDetail(scope, sessionId, selectedAgentId!),
    enabled: open && Boolean(selectedAgentId),
    refetchInterval: open && selectedAgentRunning ? 1_000 : false,
  });
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="agent-drawer-overlay" />
        <Dialog.Content className="agent-drawer">
          <div className="agent-drawer-header">
            {selectedAgentId ? <button onClick={() => onSelect(undefined)}>Agents</button> : <Dialog.Title>Agents</Dialog.Title>}
            <Dialog.Close asChild><button aria-label="关闭 Agent 面板"><X size={18} /></button></Dialog.Close>
          </div>
          {selectedAgentId ? (
            <div className="agent-transcript">
              <h3>{detail.data?.agent.name ?? 'Agent 对话'}{detail.data?.runs.at(-1) ? <small><AgentRunMeta run={detail.data.runs.at(-1)!} /></small> : null}</h3>
              {detail.isPending ? <span>加载中…</span> : detail.data ? <AgentTranscript detail={detail.data} /> : <span>无法加载 Agent 对话</span>}
            </div>
          ) : (
            <div className="agent-tree-list">
              <div className="agent-tree-root"><i />Main</div>
              {tree.agents.map((agent) => (
                <div className="agent-tree-row" key={agent.agentId}>
                  <button onClick={() => onSelect(agent.agentId)}><i className={`agent-dot ${agent.status}`} /><span><strong>{agent.name}</strong><small>{agent.definitionName} · {agent.contextMode === 'fork' ? '继承上下文' : '独立上下文'}</small></span><em>{statusLabel(tree, agent)}{runFor(tree, agent) ? <> · <AgentRunMeta run={runFor(tree, agent)!} /></> : null}</em></button>
                  {(agent.status === 'running' || agent.status === 'stopping') ? <button className="agent-stop" disabled={agent.status === 'stopping'} onClick={() => onStop(agent.agentId)}><Square size={12} fill="currentColor" /></button> : null}
                </div>
              ))}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
