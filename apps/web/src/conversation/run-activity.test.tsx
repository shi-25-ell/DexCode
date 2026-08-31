import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActiveRunView } from './run-presentation';
import { RunActivity } from './run-activity';

afterEach(cleanup);

function run(overrides: Partial<ActiveRunView> = {}): ActiveRunView {
  return {
    runId: 'run-1',
    startedAt: new Date().toISOString(),
    phase: 'requesting_model',
    phaseChangedAt: new Date().toISOString(),
    assistantDraft: null,
    committedMessages: [],
    toolsByCallId: {},
    approvalsById: {},
    contextsById: {},
    activityOrder: [],
    ...overrides,
  };
}

describe('RunActivity', () => {
  it('renders live assistant, tool, approval, and later assistant output in event order', () => {
    render(createElement(RunActivity, {
      run: run({
        committedMessages: [{
          id: 'message-1',
          kind: 'assistant',
          content: '先说明计划',
          messageId: 'message-1',
          runId: 'run-1',
          turn: 1,
        }],
        toolsByCallId: {
          'call-1': { callRef: 'call-1', category: 'command', name: '执行命令', status: 'queued', summary: '等待批准' },
        },
        approvalsById: {
          'approval-1': { id: 'approval-1', kind: 'approval', approvalRef: 'approval-1', approvalKind: 'question', title: '允许执行吗？', options: ['允许', '拒绝'] },
        },
        assistantDraft: {
          messageId: 'message-2',
          turn: 2,
          committed: false,
          hasToolCalls: false,
          blocks: { 0: { contentIndex: 0, kind: 'text', content: '命令完成后的说明' } },
        },
        activityOrder: [
          { kind: 'assistant', messageId: 'message-1' },
          { kind: 'tool', callId: 'call-1' },
          { kind: 'approval', approvalId: 'approval-1' },
          { kind: 'assistant', messageId: 'message-2' },
        ],
      }),
      needsResync: false,
    }));

    const firstMessage = screen.getByText('先说明计划');
    const tool = screen.getByText('执行命令');
    const approval = screen.getByText('允许执行吗？');
    const laterMessage = screen.getByText('命令完成后的说明');
    expect(firstMessage.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(tool.compareDocumentPosition(approval) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(approval.compareDocumentPosition(laterMessage) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('shows an exact phase without rendering an empty reasoning disclosure', () => {
    render(createElement(RunActivity, { run: run(), needsResync: false }));
    expect(screen.getByRole('status')).toHaveTextContent('正在请求模型……');
    expect(screen.queryByRole('button', { name: '展开思考过程' })).not.toBeInTheDocument();
  });

  it('keeps provider reasoning folded by default behind a keyboard-accessible button', () => {
    render(createElement(RunActivity, {
      run: run({
        phase: 'thinking',
        assistantDraft: {
          messageId: 'message-1',
          turn: 1,
          committed: false,
          hasToolCalls: false,
          blocks: { 0: { contentIndex: 0, kind: 'reasoning', content: '只在运行态展示的思考' } },
        },
        activityOrder: [{ kind: 'assistant', messageId: 'message-1' }],
      }),
      needsResync: false,
    }));
    const trigger = screen.getByRole('button', { name: '展开思考过程' });
    expect(screen.queryByText('只在运行态展示的思考')).not.toBeInTheDocument();
    expect(trigger.tagName).toBe('BUTTON');
    fireEvent.click(trigger);
    expect(screen.getByText('只在运行态展示的思考')).toBeInTheDocument();
  });

  it('keeps stop-adjacent approval and queued tool state accessible while waiting', () => {
    render(createElement(RunActivity, {
      run: run({
        phase: 'waiting_approval',
        toolsByCallId: {
          'call-1': { callRef: 'call-1', category: 'file', name: '修改文件', status: 'queued', summary: '等待批准' },
        },
        approvalsById: {
          'approval-1': { id: 'approval-1', kind: 'approval', approvalRef: 'approval-1', approvalKind: 'question', title: '继续执行吗？', options: ['继续', '停止'] },
        },
        activityOrder: [
          { kind: 'tool', callId: 'call-1' },
          { kind: 'approval', approvalId: 'approval-1' },
        ],
      }),
      needsResync: true,
    }));
    expect(screen.getByRole('status')).toHaveTextContent('等待批准……');
    expect(screen.getByText('准备中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
    expect(screen.getByText(/实时片段有缺失/)).toBeInTheDocument();
  });
});
