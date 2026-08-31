import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, CircleAlert, Files, FolderSearch2 } from 'lucide-react';
import { useState } from 'react';
import { toolBatchStatus, toolBatchSummary } from '../../../../packages/conversation-view/tool-batching';
import type { ToolBatchPresentation, ToolPresentation } from '../types';

const statusLabels = {
  running: '运行中',
  succeeded: '成功',
  warning: '部分失败',
  failed: '全部失败',
  denied: '已拒绝',
  cancelled: '已取消',
} as const;

function FileOperation({ tool }: { tool: ToolPresentation }) {
  const [open, setOpen] = useState(false);
  const change = tool.fileChange;
  const hasDiff = Boolean(change?.diff);
  return (
    <div className={`batch-operation ${tool.status}`}>
      <button type="button" disabled={!hasDiff} onClick={() => setOpen((value) => !value)} aria-expanded={hasDiff ? open : undefined}>
        <span><strong>{tool.name}</strong>{tool.target ? <code>{tool.target}</code> : null}</span>
        <span className="batch-operation-result">{change?.kind === 'created' ? '新建' : change ? '修改' : tool.summary}</span>
        {change ? <span className="diff-stat"><b>+{change.additions}</b><i>−{change.deletions}</i></span> : null}
        {hasDiff ? <ChevronDown className={open ? 'chevron open' : 'chevron'} size={15} /> : null}
      </button>
      {open && change ? (
        <div className="batch-diff">
          <div>{change.kind === 'created' ? '新建文件' : '修改文件'}{change.truncated ? ' · diff 已截断' : ''}</div>
          <pre>{change.diff}</pre>
        </div>
      ) : null}
    </div>
  );
}

export function ToolBatchCard({ batch }: { batch: ToolBatchPresentation }) {
  const [open, setOpen] = useState(false);
  const state = toolBatchStatus(batch);
  const Icon = batch.type === 'inspection' ? FolderSearch2 : Files;
  const failures = batch.members.filter((member) => member.status === 'failed');
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={`tool-card tool-batch-card ${state.status}`}>
      <Collapsible.Trigger className="tool-card-trigger" aria-label={`${batch.type === 'inspection' ? '检查文件' : '修改文件'}，展开批次详情`}>
        <span className="tool-icon"><Icon size={16} strokeWidth={1.8} /></span>
        <span className="tool-main">
          <span className="tool-title-line"><strong>{batch.type === 'inspection' ? '检查文件' : '修改文件'}</strong></span>
          <span className="tool-summary">{toolBatchSummary(batch)}</span>
          {failures.length > 0 ? (
            <span className="batch-error-summaries">
              {failures.map((member) => <span key={member.callRef}>{member.target ? `${member.target}：` : ''}{member.summary}</span>)}
            </span>
          ) : null}
        </span>
        <span className={`tool-status ${state.status}`}>
          {state.status === 'warning' || state.status === 'failed' ? <CircleAlert size={14} /> : null}
          {statusLabels[state.status]}
          {state.failed > 0 ? <b className="failure-badge">{state.failed} 项失败</b> : null}
        </span>
        <ChevronDown className={open ? 'chevron open' : 'chevron'} size={16} />
      </Collapsible.Trigger>
      <Collapsible.Content className="tool-output batch-output">
        {batch.type === 'inspection' ? (
          <div className="batch-operation-list">
            {batch.members.map((member) => (
              <div className={`batch-inspection-row ${member.status}`} key={member.callRef}>
                <strong>{member.name}</strong>
                {member.target ? <code>{member.target}</code> : <span />}
                <span>{member.summary}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="batch-operation-list">
            {batch.members.map((member) => <FileOperation key={member.callRef} tool={member} />)}
          </div>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
