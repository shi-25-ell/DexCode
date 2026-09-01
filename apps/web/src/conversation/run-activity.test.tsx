import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActiveRunView } from './run-presentation';
import { RunActivity } from './run-activity';
import type { AgentTreeSnapshot } from '../types';

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
  it('merges live commands while preserving separate approval controls', () => {
    const command = (callRef: string, target: string) => ({ callRef, toolName: 'run_command', category: 'command' as const, name: '执行命令', target, status: 'queued' as const, summary: '准备执行' });
    render(createElement(RunActivity, {
      run: run({
        toolsByCallId: { first: command('first', 'npm test'), second: command('second', 'npm run lint') },
        approvalsById: {
          'approval-1': { id: 'approval-1', kind: 'approval', approvalRef: 'approval-1', approvalKind: 'tool', toolName: 'run_command', effect: 'execute', title: '批准 npm test', reason: 'test', fingerprint: 'one', options: ['allow_once', 'allow_whitelist', 'deny'] },
          'approval-2': { id: 'approval-2', kind: 'approval', approvalRef: 'approval-2', approvalKind: 'tool', toolName: 'run_command', effect: 'execute', title: '批准 npm run lint', reason: 'lint', fingerprint: 'two', options: ['allow_once', 'allow_whitelist', 'deny'] },
        },
        activityOrder: [
          { kind: 'tool', callId: 'first' }, { kind: 'approval', approvalId: 'approval-1' },
          { kind: 'tool', callId: 'second' }, { kind: 'approval', approvalId: 'approval-2' },
        ],
      }), needsResync: false,
    }));
    expect(screen.getByText('执行了 2 个命令操作 · 异常 0 个')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '允许一次' })).toHaveLength(2);
  });

  it('renders one live batch per activity-order segment, including an invisible assistant boundary', () => {
    const read = (callRef: string) => ({ callRef, toolName: 'read_file', category: 'read' as const, name: '读取文件', target: `${callRef}.ts`, status: 'succeeded' as const, summary: '读取完成' });
    render(createElement(RunActivity, {
      run: run({
        toolsByCallId: { first: read('first'), second: read('second'), third: read('third') },
        assistantDraft: { messageId: 'empty', turn: 1, committed: false, hasToolCalls: true, blocks: {} },
        activityOrder: [
          { kind: 'tool', callId: 'first' },
          { kind: 'tool', callId: 'second' },
          { kind: 'assistant', messageId: 'empty' },
          { kind: 'tool', callId: 'third' },
        ],
      }),
      needsResync: false,
    }));
    expect(screen.getAllByText('检查文件')).toHaveLength(2);
    expect(screen.getByText('检查了 2 个文件 · 2 项操作')).toBeInTheDocument();
    expect(screen.getByText('检查了 1 个文件 · 1 项操作')).toBeInTheDocument();
  });

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
          'call-1': { callRef: 'call-1', toolName: 'run_command', category: 'command', name: '执行命令', status: 'queued', summary: '等待批准' },
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

  it('keeps a live child Agent card at its invoking assistant turn', () => {
    const tree: AgentTreeSnapshot = {
      version: 1, sessionId: 'session-1', rootAgentId: 'root', revision: 1,
      agents: [{
        agentId: 'agent-a', sessionId: 'session-1', rootAgentId: 'root', parentAgentId: 'root', createdByRunId: 'run-1',
        name: 'greeter', task: '问好', contextMode: 'fork', isolation: 'shared', definitionName: 'general-purpose',
        status: 'running', currentRunId: 'agent-run-a', lastRunId: 'agent-run-a', createdAt: '', updatedAt: '',
      }],
      runs: [{
        agentRunId: 'agent-run-a', agentId: 'agent-a', invokedByRunId: 'run-1', invokedByTurn: 1,
        invokedByToolCallId: 'spawn-1', delegationGroupId: 'group-1', trigger: 'spawn', status: 'running', input: '问好', startedAt: '',
      }],
    };
    render(createElement(RunActivity, {
      run: run({
        committedMessages: [
          { id: 'message-1', kind: 'assistant', content: '先调用子 Agent', messageId: 'message-1', runId: 'run-1', turn: 1 },
        ],
        assistantDraft: {
          messageId: 'message-2', turn: 2, committed: false, hasToolCalls: false,
          blocks: { 0: { contentIndex: 0, kind: 'text', content: '子 Agent 已返回' } },
        },
        activityOrder: [
          { kind: 'assistant', messageId: 'message-1' },
          { kind: 'assistant', messageId: 'message-2' },
        ],
      }),
      needsResync: false,
      agentTree: tree,
      agentGroups: [{ key: 'group-1', agentRunIds: ['agent-run-a'], sourceRunId: 'run-1', sourceTurn: 1 }],
      onOpenAgent: () => {},
      onStopAgent: () => {},
    }));
    const invokingMessage = screen.getByText('先调用子 Agent');
    const child = screen.getByText('greeter');
    const finalMessage = screen.getByText('子 Agent 已返回');
    expect(invokingMessage.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(child.compareDocumentPosition(finalMessage) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('uses the exact invocation entry before later streamed text', () => {
    const tree: AgentTreeSnapshot = {
      version: 1, sessionId: 'session-1', rootAgentId: 'root', revision: 1,
      agents: [{
        agentId: 'agent-a', sessionId: 'session-1', rootAgentId: 'root', parentAgentId: 'root', createdByRunId: 'run-1',
        name: 'greeter', task: '问好', contextMode: 'fresh', isolation: 'shared', definitionName: 'general',
        status: 'running', currentRunId: 'agent-run-a', lastRunId: 'agent-run-a', createdAt: '', updatedAt: '',
      }],
      runs: [{
        agentRunId: 'agent-run-a', agentId: 'agent-a', invokedByRunId: 'run-1', invokedByTurn: 1,
        invokedByToolCallId: 'spawn-1', delegationGroupId: 'group-1', trigger: 'spawn', status: 'running', input: '问好', startedAt: '',
      }],
    };
    render(createElement(RunActivity, {
      run: run({
        committedMessages: [{ id: 'message-1', kind: 'assistant', content: '现在调用', messageId: 'message-1', runId: 'run-1', turn: 1 }],
        assistantDraft: { messageId: 'message-2', turn: 2, committed: false, hasToolCalls: false, blocks: { 0: { contentIndex: 0, kind: 'text', content: '已经启动' } } },
        activityOrder: [
          { kind: 'assistant', messageId: 'message-1' },
          { kind: 'agent', callId: 'spawn-1', agentId: 'agent-a', agentRunId: 'agent-run-a', turn: 1 },
          { kind: 'assistant', messageId: 'message-2' },
        ],
      }),
      needsResync: false,
      agentTree: tree,
      agentGroups: [{ key: 'group-1', agentRunIds: ['agent-run-a'], sourceRunId: 'run-1', sourceTurn: 1 }],
      onOpenAgent: () => {},
      onStopAgent: () => {},
    }));
    const invokingMessage = screen.getByText('现在调用');
    const child = screen.getByText('greeter');
    const laterMessage = screen.getByText('已经启动');
    expect(invokingMessage.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(child.compareDocumentPosition(laterMessage) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getAllByText('greeter')).toHaveLength(1);
  });

  it('shows an exact phase without rendering an empty reasoning disclosure', () => {
    render(createElement(RunActivity, { run: run(), needsResync: false }));
    expect(screen.getByRole('status')).toHaveTextContent('正在请求模型……');
    expect(screen.queryByRole('button', { name: '展开思考过程' })).not.toBeInTheDocument();
  });

  it('keeps the live phase below the latest streamed activity', () => {
    render(createElement(RunActivity, {
      run: run({
        committedMessages: [{ id: 'message-1', messageId: 'message-1', kind: 'assistant', content: '最新流式内容', turn: 1, final: false }],
        activityOrder: [{ kind: 'assistant', messageId: 'message-1' }],
      }),
      needsResync: false,
    }));
    const message = screen.getByText('最新流式内容');
    const phase = screen.getByRole('status');
    expect(message.compareDocumentPosition(phase) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
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
          'call-1': { callRef: 'call-1', toolName: 'write_file', category: 'file', name: '修改文件', status: 'queued', summary: '等待批准' },
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
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
    expect(screen.getByText(/实时片段有缺失/)).toBeInTheDocument();
  });
});
