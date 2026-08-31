import { apiJson } from '../api';
import type { ConversationItem } from '../types';

function approvalLabel(value: string): string {
  if (value === 'deny') return '已拒绝';
  if (value === 'allow_whitelist') return '已加入白名单';
  if (value === 'allow_once' || value === 'allow') return '允许一次';
  return value;
}

export function ApprovalCard({ item, workspaceRef, onResolve }: {
  item: Extract<ConversationItem, { kind: 'approval' }>;
  workspaceRef?: string;
  onResolve?: (answer: string) => void;
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
    onResolve?.(answer);
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
