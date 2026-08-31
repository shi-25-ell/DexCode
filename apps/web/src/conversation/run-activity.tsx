import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RunPhase } from '../../../../packages/run-protocol/contracts';
import { ApprovalCard } from './approval-card';
import { AssistantMessage } from './assistant-message';
import { ContextCard } from './context-card';
import { draftReasoning, draftText, type ActiveRunView } from './run-presentation';
import { ToolCard } from './tool-card';

export const phaseLabels: Record<RunPhase, string> = {
  preparing_context: '正在准备上下文……',
  requesting_model: '正在请求模型……',
  thinking: '正在思考……',
  answering: '正在生成回答……',
  preparing_tool: '正在准备工具……',
  waiting_approval: '等待批准……',
  running_tool: '正在执行工具……',
  retrying: '正在重试……',
  finalizing: '正在整理最终结果……',
};

function elapsedSeconds(startedAt: string, now: number): number {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
}

function ElapsedTime({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <time dateTime={startedAt}>{elapsedSeconds(startedAt, now)} 秒</time>;
}

function ReasoningDisclosure({ content, truncated, textStarted, startedAt, completedAt }: { content: string; truncated: boolean; textStarted: boolean; startedAt: string; completedAt?: string }) {
  const [open, setOpen] = useState(false);
  const [manuallyChanged, setManuallyChanged] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (textStarted && !manuallyChanged) setOpen(false);
  }, [manuallyChanged, textStarted]);
  const seconds = elapsedSeconds(startedAt, completedAt ? Date.parse(completedAt) : now);
  return (
    <Collapsible.Root open={open} onOpenChange={(next) => { setOpen(next); setManuallyChanged(true); }} className="reasoning-disclosure">
      <Collapsible.Trigger className="reasoning-trigger" aria-label={`${open ? '收起' : '展开'}思考过程`}>
        <span>{seconds > 0 ? `思考了 ${seconds} 秒` : '思考过程'}{truncated ? ' · 展示已截断' : ''}</span>
        <ChevronDown className={open ? 'chevron open' : 'chevron'} size={15} />
      </Collapsible.Trigger>
      <Collapsible.Content className="reasoning-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function RunActivity({ run, workspaceRef, needsResync }: { run: ActiveRunView; workspaceRef?: string; needsResync: boolean }) {
  const text = draftText(run.assistantDraft);
  const reasoning = draftReasoning(run.assistantDraft);
  const tools = Object.values(run.toolsByCallId);
  const approvals = Object.values(run.approvalsById);
  const contexts = Object.values(run.contextsById);
  return (
    <section className="run-activity" aria-label="当前运行" aria-live="polite">
      <div className={`run-phase ${run.phase}`} role="status">
        <LoaderCircle className="run-phase-spinner" size={16} aria-hidden="true" />
        <span>{phaseLabels[run.phase]}</span>
        <ElapsedTime key={run.phaseChangedAt} startedAt={run.phaseChangedAt} />
        {run.note ? <small>{run.note}</small> : null}
      </div>
      {needsResync ? <div className="run-resync-note">实时片段有缺失，完成后将使用已提交会话校准。</div> : null}
      {run.committedMessages.map((item) => item.kind === 'assistant' ? <AssistantMessage key={item.id} content={item.content} showCopy={false} /> : null)}
      {reasoning ? <ReasoningDisclosure content={reasoning.content} truncated={reasoning.truncated} textStarted={Boolean(text)} startedAt={run.reasoningStartedAt ?? run.startedAt} completedAt={run.reasoningCompletedAt} /> : null}
      {text ? <AssistantMessage key={run.assistantDraft?.messageId} content={text} showCopy={false} /> : null}
      {contexts.map((context) => <ContextCard key={context.operationRef} context={context} />)}
      {tools.map((tool) => <ToolCard key={tool.callRef} tool={tool} />)}
      {approvals.map((approval) => <ApprovalCard key={approval.approvalRef} item={approval} workspaceRef={workspaceRef} />)}
    </section>
  );
}
