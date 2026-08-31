import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationItem } from '../types';
import { ApprovalCard } from './approval-card';
import { assistantResponseCopyText, groupConversationHistory, isCompleteAssistantResponse } from './response-boundary';
import { ToolCard } from './tool-card';
import { ContextCard } from './context-card';
import { shouldShowConversationLoading, terminalTitle } from './conversation-page';

vi.stubGlobal('crypto', { randomUUID: () => 'test-id' });

describe('conversation presentation', () => {
  it('labels independent run limits without collapsing them into one message', () => {
    expect(terminalTitle('limited', 'model_turn_limit')).toBe('模型回合数达到限制');
    expect(terminalTitle('limited', 'model_attempt_limit')).toBe('模型尝试次数达到限制');
    expect(terminalTitle('limited', 'output_token_limit')).toBe('单次模型输出达到长度限制');
  });

  it('keeps the optimistic timeline visible while a new draft Session is materializing', () => {
    expect(shouldShowConversationLoading({
      hasConversationRef: true,
      hasSnapshot: false,
      snapshotPending: true,
      materializingDraft: true,
    })).toBe(false);
  });

  it('collapses committed process items behind each final answer and copies only the final answer', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user', content: '搜索仓库' },
      { id: 'a1', kind: 'assistant', content: '我先搜索' },
      { id: 't1', kind: 'tool', tool: { callRef: 'call-1', toolName: 'mcp__one', category: 'mcp', name: '调用 MCP', status: 'succeeded', summary: '完成' } },
      { id: 'a2', kind: 'assistant', content: '请完成授权', final: true },
      { id: 'u2', kind: 'user', content: '授权完成' },
      { id: 'a3', kind: 'assistant', content: '我重新尝试' },
      { id: 't2', kind: 'tool', tool: { callRef: 'call-2', toolName: 'mcp__two', category: 'mcp', name: '调用 MCP', status: 'succeeded', summary: '完成' } },
      { id: 'a4', kind: 'assistant', content: '这是最终结果', final: true },
    ];

    expect(items.map((item) => isCompleteAssistantResponse(item, 'idle'))).toEqual([false, false, false, true, false, false, false, true]);
    expect(isCompleteAssistantResponse(items[7]!, 'running')).toBe(false);
    expect(assistantResponseCopyText(items[3]!)).toBe('请完成授权');
    expect(assistantResponseCopyText(items[7]!)).toBe('这是最终结果');
    expect(groupConversationHistory(items)).toMatchObject([
      { kind: 'item', entry: { item: { id: 'u1' } } },
      { kind: 'completed_response', history: [{ item: { id: 'a1' } }, { item: { id: 't1' } }], final: { item: { id: 'a2' } } },
      { kind: 'item', entry: { item: { id: 'u2' } } },
      { kind: 'completed_response', history: [{ item: { id: 'a3' } }, { item: { id: 't2' } }], final: { item: { id: 'a4' } } },
    ]);
  });

  it('folds execution on both sides of Steer messages only after the Run has a final answer', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user', content: '原始任务' },
      { id: 'a1', kind: 'assistant', content: 'Steer 前执行', runId: 'run-1' },
      { id: 't1', kind: 'tool', tool: { callRef: 'call-1', toolName: 'read_file', category: 'read', name: '读取文件', status: 'succeeded', summary: '完成' } },
      { id: 'u2', kind: 'user', content: '第一次调整方向', delivery: 'steer' },
      { id: 'a2', kind: 'assistant', content: '第一次 Steer 后执行', runId: 'run-1' },
      { id: 't2', kind: 'tool', tool: { callRef: 'call-2', toolName: 'search_in_workspace', category: 'search', name: '搜索代码', status: 'succeeded', summary: '完成' } },
      { id: 'u3', kind: 'user', content: '第二次调整方向', delivery: 'steer' },
      { id: 'a3', kind: 'assistant', content: '第二次 Steer 后执行', runId: 'run-1' },
      { id: 't3', kind: 'tool', tool: { callRef: 'call-3', toolName: 'run_command', category: 'command', name: '执行命令', status: 'succeeded', summary: '完成' } },
      { id: 'a4', kind: 'assistant', content: '最终结果', runId: 'run-1', final: true },
    ];

    expect(groupConversationHistory(items.slice(0, -1)).some((group) => group.kind === 'execution_history')).toBe(false);
    expect(groupConversationHistory(items)).toMatchObject([
      { kind: 'item', entry: { item: { id: 'u1' } } },
      { kind: 'execution_history', history: [{ item: { id: 'a1' } }, { item: { id: 't1' } }] },
      { kind: 'item', entry: { item: { id: 'u2', delivery: 'steer' } } },
      { kind: 'execution_history', history: [{ item: { id: 'a2' } }, { item: { id: 't2' } }] },
      { kind: 'item', entry: { item: { id: 'u3', delivery: 'steer' } } },
      { kind: 'completed_response', history: [{ item: { id: 'a3' } }, { item: { id: 't3' } }], final: { item: { id: 'a4' } } },
    ]);
  });

  it('keeps unfinished and failed response items expanded when no final answer exists', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user', content: '运行测试' },
      { id: 'a1', kind: 'assistant', content: '正在运行' },
      { id: 'e1', kind: 'error', title: '本次运行未完成', message: '测试失败' },
    ];
    expect(groupConversationHistory(items).map((group) => group.kind)).toEqual(['item', 'item', 'item']);
  });

  it('keeps a failed command inside the completed response execution history', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user', content: '运行测试' },
      { id: 'a1', kind: 'assistant', content: '我来运行测试' },
      { id: 't1', kind: 'tool', tool: { callRef: 'call-1', toolName: 'run_command', category: 'command', name: '执行命令', status: 'failed', summary: '测试失败' } },
      { id: 'a2', kind: 'assistant', content: '测试失败，原因如下', final: true },
    ];
    const response = groupConversationHistory(items)[1];
    expect(response).toMatchObject({
      kind: 'completed_response',
      history: [{ item: { id: 'a1' } }, { item: { id: 't1', tool: { status: 'failed' } } }],
      final: { item: { id: 'a2' } },
    });
  });

  it('does not expose a copy action before a pending approval', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user', content: '运行命令' },
      { id: 'a1', kind: 'assistant', content: '需要你的确认' },
      { id: 'p1', kind: 'approval', approvalRef: 'approval-1', approvalKind: 'command', title: '确认命令', options: ['allow_once', 'deny'] },
    ];

    expect(isCompleteAssistantResponse(items[1]!, 'waiting')).toBe(false);
  });

  it('renders file stats and keeps readable output behind an explicit disclosure', () => {
    render(createElement(ToolCard, { tool: {
      callRef: 'opaque-ref',
      toolName: 'patch_file',
      category: 'file',
      name: '修改文件',
      target: 'src/app.ts',
      status: 'succeeded',
      summary: '文件已更新',
      fileChange: { path: 'src/app.ts', kind: 'modified', additions: 18, deletions: 6, diff: '--- a/src/app.ts\n+++ b/src/app.ts\n', truncated: false },
      rawOutput: '受控原始输出',
    } }));
    expect(screen.getByText('+18')).toBeInTheDocument();
    expect(screen.getByText('−6')).toBeInTheDocument();
    expect(screen.queryByText('受控原始输出')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '修改文件，展开输出内容' }));
    expect(screen.getByText('受控原始输出')).toBeInTheDocument();
    expect(screen.queryByText('opaque-ref')).not.toBeInTheDocument();
  });

  it('shows only memory mutations and expands an upsert with its actual markdown content', () => {
    const hiddenMemoryTools = ['浏览记忆', '读取记忆', '搜索记忆'];
    const { rerender } = render(createElement(ToolCard, { tool: {
      callRef: 'memory-read', toolName: 'memory_read', category: 'memory', name: '读取记忆', target: 'project.md', status: 'succeeded', summary: '执行完成', rawOutput: '内部读取结果',
    } }));
    expect(screen.queryByText('读取记忆')).not.toBeInTheDocument();

    for (const name of hiddenMemoryTools) {
      rerender(createElement(ToolCard, { tool: {
        callRef: name, toolName: 'memory_list', category: 'memory', name, status: 'succeeded', summary: '执行完成',
      } }));
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    }

    rerender(createElement(ToolCard, { tool: {
      callRef: 'memory-remove', toolName: 'memory_remove', category: 'memory', name: '删除记忆', target: 'obsolete.md', status: 'succeeded', summary: '项目记忆已删除',
    } }));
    expect(screen.getByText('删除记忆')).toBeInTheDocument();
    expect(screen.getByText('项目记忆已删除')).toBeInTheDocument();

    rerender(createElement(ToolCard, { tool: {
      callRef: 'memory-upsert', toolName: 'memory_upsert', category: 'memory', name: '更新记忆', target: 'project.md', status: 'succeeded', summary: '项目记忆已更新',
      rawOutput: '---\nname: Project\ndescription: Current project facts\ntype: project\n---\n\n# Build\n\nUse npm test.\n',
    } }));
    fireEvent.click(screen.getByRole('button', { name: '更新记忆，展开输出内容' }));
    expect(screen.getByText(/name: Project/)).toBeInTheDocument();
    expect(screen.queryByText(/operationId|digest/)).not.toBeInTheDocument();
  });

  it('shows a Skill card only for activate_skill', () => {
    const { rerender } = render(createElement(ToolCard, { tool: {
      callRef: 'skill-read', toolName: 'read_skill', category: 'skill', name: '使用 Skill', target: 'codebase-design', status: 'succeeded', summary: '已加载能力说明',
    } }));
    expect(screen.queryByText('codebase-design')).not.toBeInTheDocument();

    rerender(createElement(ToolCard, { tool: {
      callRef: 'skill-activate', toolName: 'activate_skill', category: 'skill', name: '使用 Skill', target: 'codebase-design', status: 'succeeded', summary: '已加载能力说明',
    } }));
    expect(screen.getByText('codebase-design')).toBeInTheDocument();

    rerender(createElement(ToolCard, { tool: {
      callRef: 'skill-deactivate', toolName: 'deactivate_skill', category: 'skill', name: '停用 Skill', target: 'codebase-design', status: 'succeeded', summary: '执行完成',
    } }));
    expect(screen.queryByText('codebase-design')).not.toBeInTheDocument();
  });

  it('updates one Context Card by operation ref and reports only actions that occurred', () => {
    const context = {
      operationRef: 'context-1',
      status: 'completed' as const,
      beforeTokens: 12_000,
      afterTokens: 5_000,
      archivedMessages: 18,
      archivedConversationSegments: 4,
      summarizedMessages: 0,
      breakdown: { systemPrompt: 500, workspaceCode: 1_000, recentConversation: 2_000, toolResults: 500, projectMemory: 300, managedMemory: 0, toolDefinitions: 500, other: 200 },
    };

    render(createElement(ContextCard, { context }));
    fireEvent.click(screen.getByRole('button', { name: /展开整理详情/ }));
    expect(screen.getByText(/18 条历史消息已归档/)).toBeInTheDocument();
    expect(screen.queryByText(/已生成对话摘要/)).not.toBeInTheDocument();
  });

  it('submits generic tool approval with the bound fingerprint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const resolved = vi.fn();
    render(createElement(ApprovalCard, {
      item: {
        id: 'approval-1',
        kind: 'approval',
        approvalRef: 'approval-1',
        approvalKind: 'tool',
        toolName: 'write_file',
        effect: 'write',
        title: '批准文件修改',
        target: 'src/app.ts',
        reason: '逐次批准需要批准此副作用',
        fingerprint: 'fingerprint-1',
        options: ['allow_once', 'deny'],
      },
      workspaceRef: 'workspace-1',
      onResolve: resolved,
    }));

    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/agent/approval', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ approvalId: 'approval-1', decision: 'allow_once', fingerprint: 'fingerprint-1' }),
    })));
    expect(resolved).toHaveBeenCalledWith('allow_once');
  });
});
