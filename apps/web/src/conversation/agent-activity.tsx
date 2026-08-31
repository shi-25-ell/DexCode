import * as Dialog from '@radix-ui/react-dialog';
import { Bot, ChevronRight, Square, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getAgentDetail } from '../api';
import type { AgentDetail, AgentRecordView, AgentRunView, AgentToolView, AgentTreeSnapshot, ConversationScope, ToolPresentation } from '../types';
import { AssistantMessage } from './assistant-message';
import { ToolCard } from './tool-card';
import { UserMessage } from './user-message';

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
            <em>{runStatusLabel(run, agent)}</em><ChevronRight size={15} />
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

export function AgentTranscript({ detail }: { detail: AgentDetail }) {
  const detailTools = detail.tools ?? [];
  const tools = new Map(detailTools.map((tool) => [tool.callId, tool]));
  const renderedTools = new Set<string>();
  const entries: ReactNode[] = [];
  const appendTool = (callId: string, name: string, key: string, output?: string) => {
    if (renderedTools.has(callId)) return;
    renderedTools.add(callId);
    const tool = tools.get(callId);
    entries.push(<ToolCard key={key} tool={tool?.presentation ?? fallbackToolPresentation(tool, { callId, name, ...(output ? { output } : {}) })} />);
  };

  detail.messages.forEach((message, index) => {
    if (message.role === 'user') {
      entries.push(<UserMessage key={`user-${index}`} content={message.content} />);
      return;
    }
    if (message.role === 'assistant') {
      if (message.content?.trim()) entries.push(<AssistantMessage key={`assistant-${index}`} content={message.content} />);
      for (const call of message.tool_calls ?? []) appendTool(call.id, call.function.name, `tool-${call.id}`);
      return;
    }
    if (message.role === 'tool') appendTool(message.tool_call_id, message.name, `tool-${message.tool_call_id}`, message.content);
  });
  for (const tool of detailTools) appendTool(tool.callId, tool.name, `tool-${tool.callId}`);

  return <div className="agent-transcript-stream">{entries.length > 0 ? entries : <p className="agent-transcript-empty">尚无对话内容</p>}</div>;
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
              <h3>{detail.data?.agent.name ?? 'Agent 对话'}</h3>
              <p>{detail.data?.agent.task}</p>
              {detail.isPending ? <span>加载中…</span> : detail.data ? <AgentTranscript detail={detail.data} /> : <span>无法加载 Agent 对话</span>}
            </div>
          ) : (
            <div className="agent-tree-list">
              <div className="agent-tree-root"><i />Main</div>
              {tree.agents.map((agent) => (
                <div className="agent-tree-row" key={agent.agentId}>
                  <button onClick={() => onSelect(agent.agentId)}><i className={`agent-dot ${agent.status}`} /><span><strong>{agent.name}</strong><small>{agent.definitionName} · {agent.contextMode === 'fork' ? '继承上下文' : '独立上下文'}</small></span><em>{statusLabel(tree, agent)}</em></button>
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
