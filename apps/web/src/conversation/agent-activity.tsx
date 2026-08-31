import * as Dialog from '@radix-ui/react-dialog';
import { Bot, ChevronRight, Square, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getAgentDetail } from '../api';
import type { AgentRecordView, AgentTreeSnapshot, ConversationScope } from '../types';

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

export function AgentActivityCard({ tree, agentIds, onOpen, onStop }: {
  tree: AgentTreeSnapshot; agentIds: string[]; onOpen(agentId: string): void; onStop(agentId: string): void;
}) {
  const agents = agentIds.map((id) => tree.agents.find((agent) => agent.agentId === id)).filter((agent): agent is AgentRecordView => Boolean(agent));
  if (agents.length === 0) return null;
  return (
    <section className="agent-activity-card">
      <div className="agent-card-heading"><span><Bot size={17} />{agents.length > 1 ? '并行任务' : '子 Agent'}</span><small>{agents.length} Agents</small></div>
      {agents.map((agent) => (
        <div className="agent-card-row" key={agent.agentId}>
          <button className="agent-card-main" onClick={() => onOpen(agent.agentId)}>
            <i className={`agent-dot ${agent.status}`} />
            <span><strong>{agent.name}</strong><small>{agent.task}</small></span>
            <em>{statusLabel(tree, agent)}</em><ChevronRight size={15} />
          </button>
          {(agent.status === 'running' || agent.status === 'stopping') ? <button className="agent-stop" disabled={agent.status === 'stopping'} onClick={() => onStop(agent.agentId)} aria-label={`停止 ${agent.name}`}><Square size={12} fill="currentColor" /></button> : null}
        </div>
      ))}
    </section>
  );
}

export function AgentDrawer({ open, onOpenChange, tree, scope, sessionId, selectedAgentId, onSelect, onStop }: {
  open: boolean; onOpenChange(open: boolean): void; tree: AgentTreeSnapshot; scope: ConversationScope; sessionId: string;
  selectedAgentId?: string; onSelect(agentId?: string): void; onStop(agentId: string): void;
}) {
  const detail = useQuery({
    queryKey: ['agent-detail', scope, sessionId, selectedAgentId],
    queryFn: () => getAgentDetail(scope, sessionId, selectedAgentId!),
    enabled: open && Boolean(selectedAgentId),
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
              {detail.isPending ? <span>加载中…</span> : detail.data?.messages.map((message, index) => (
                <article key={index} className={`agent-message ${message.role}`}><small>{message.role === 'user' ? '任务' : message.role === 'assistant' ? 'Agent' : message.name ?? '工具'}</small><pre>{message.content ?? ''}</pre></article>
              ))}
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
