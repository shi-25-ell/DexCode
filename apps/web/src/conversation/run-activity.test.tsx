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
    ...overrides,
  };
}

describe('RunActivity', () => {
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
      }),
      needsResync: true,
    }));
    expect(screen.getByRole('status')).toHaveTextContent('等待批准……');
    expect(screen.getByText('准备中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
    expect(screen.getByText(/实时片段有缺失/)).toBeInTheDocument();
  });
});
