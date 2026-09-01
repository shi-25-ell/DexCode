import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { ToolPresentation } from '../types';
import { statusIcons, toolIcons } from '../shared/icons';

const statusLabels: Record<ToolPresentation['status'], string> = {
  queued: '准备中',
  running: '运行中',
  succeeded: '成功',
  invalid: '参数错误',
  blocked: '已阻止',
  failed: '失败',
  denied: '已拒绝',
  cancelled: '已取消',
};

export function ToolCard({ tool }: { tool: ToolPresentation }) {
  const [open, setOpen] = useState(false);
  if (tool.category === 'skill' && tool.toolName !== 'read_skill') return null;
  if (tool.category === 'memory' && tool.toolName !== 'memory_upsert' && tool.toolName !== 'memory_remove') return null;
  const ToolIcon = toolIcons[tool.category];
  const StatusIcon = statusIcons[tool.status];
  const hasDetails = Boolean(tool.rawOutput);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={`tool-card ${tool.status}`}>
      <Collapsible.Trigger className="tool-card-trigger" disabled={!hasDetails} aria-label={`${tool.name}${hasDetails ? '，展开输出内容' : ''}`}>
        <span className="tool-icon"><ToolIcon size={16} strokeWidth={1.8} /></span>
        <span className="tool-main">
          <span className="tool-title-line">
            <strong>{tool.name}</strong>
            {tool.target ? <code>{tool.target}</code> : null}
            {tool.fileChange && (tool.fileChange.additions || tool.fileChange.deletions) ? (
              <span className="diff-stat"><b>+{tool.fileChange.additions ?? 0}</b><i>−{tool.fileChange.deletions ?? 0}</i></span>
            ) : null}
          </span>
          <span className="tool-summary">{tool.summary}</span>
        </span>
        <span className={`tool-status ${tool.status}`}><StatusIcon size={14} />{statusLabels[tool.status]}</span>
        {hasDetails ? <ChevronDown className={open ? 'chevron open' : 'chevron'} size={16} /> : null}
      </Collapsible.Trigger>
      {hasDetails ? (
        <Collapsible.Content className="tool-output">
          <div className="tool-output-heading">输出内容{tool.truncated ? ' · 已截断' : ''}</div>
          <pre>{tool.rawOutput}</pre>
        </Collapsible.Content>
      ) : null}
    </Collapsible.Root>
  );
}
