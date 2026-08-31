import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, Layers } from 'lucide-react';
import { useState } from 'react';
import type { ContextPresentation } from '../types';

const labels = {
  systemPrompt: '系统提示词',
  workspaceCode: '工作区代码',
  recentConversation: '近期对话',
  toolResults: '工具结果',
  projectMemory: '项目记忆',
  managedMemory: '自动记忆',
  toolDefinitions: '工具定义',
  other: '其他开销',
} as const;

function compactTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

export function ContextCard({ context }: { context: ContextPresentation }) {
  const [open, setOpen] = useState(false);
  const actions = [
    context.externalizedToolResults ? `${context.externalizedToolResults} 个大工具结果已外置` : '',
    context.compactedToolResults ? `${context.compactedToolResults} 个旧工具结果已清理` : '',
    context.archivedMessages ? `${context.archivedMessages} 条历史消息已归档` : '',
    context.summarizedMessages ? `${context.summarizedMessages} 条历史消息已生成对话摘要` : '',
    context.retainedConversationSegments ? `最近 ${context.retainedConversationSegments} 段对话保留完整内容` : '',
  ].filter(Boolean);
  const hasDetails = context.status === 'completed' && Boolean(context.breakdown || actions.length > 0);
  const title = context.status === 'running'
    ? '正在整理上下文……'
    : context.status === 'failed'
      ? '上下文整理未完成，原始内容已保留'
      : context.beforeTokens !== undefined && context.afterTokens !== undefined
        ? `上下文已从 ${compactTokens(context.beforeTokens)} 降至 ${compactTokens(context.afterTokens)}`
        : '上下文已整理';
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={`context-card ${context.status}`}>
      <Collapsible.Trigger className="context-card-trigger" disabled={!hasDetails} aria-label={`${title}${hasDetails ? '，展开整理详情' : ''}`}>
        <span className="context-card-icon"><Layers size={16} strokeWidth={1.8} /></span>
        <span className="context-card-title">{title}</span>
        {hasDetails ? <ChevronDown className={open ? 'chevron open' : 'chevron'} size={16} /> : null}
      </Collapsible.Trigger>
      {hasDetails ? (
        <Collapsible.Content className="context-card-details">
          {context.breakdown ? (
            <dl>
              {(Object.keys(labels) as Array<keyof typeof labels>).filter((key) => (context.breakdown?.[key] ?? 0) > 0).map((key) => (
                <div key={key}><dt>{labels[key]}</dt><dd>{compactTokens(context.breakdown![key])}</dd></div>
              ))}
            </dl>
          ) : null}
          {actions.length > 0 ? <div className="context-actions"><strong>本轮处理</strong>{actions.map((action) => <span key={action}>✓ {action}</span>)}</div> : null}
        </Collapsible.Content>
      ) : null}
    </Collapsible.Root>
  );
}
