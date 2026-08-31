import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationItem } from '../types';
import { ApprovalCard } from './approval-card';
import { assistantResponseCopyText, isCompleteAssistantResponse } from './response-boundary';
import { ToolCard } from './tool-card';
import { ContextCard } from './context-card';

vi.stubGlobal('crypto', { randomUUID: () => 'test-id' });

describe('conversation presentation', () => {
  it('only marks the terminal assistant segment of each completed response as copyable', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user', content: '搜索仓库' },
      { id: 'a1', kind: 'assistant', content: '我先搜索' },
      { id: 't1', kind: 'tool', tool: { callRef: 'call-1', category: 'mcp', name: '调用 MCP', status: 'succeeded', summary: '完成' } },
      { id: 'a2', kind: 'assistant', content: '请完成授权', final: true },
      { id: 'u2', kind: 'user', content: '授权完成' },
      { id: 'a3', kind: 'assistant', content: '我重新尝试' },
      { id: 't2', kind: 'tool', tool: { callRef: 'call-2', category: 'mcp', name: '调用 MCP', status: 'succeeded', summary: '完成' } },
      { id: 'a4', kind: 'assistant', content: '这是最终结果', final: true },
    ];

    expect(items.map((item) => isCompleteAssistantResponse(item, 'idle'))).toEqual([false, false, false, true, false, false, false, true]);
    expect(isCompleteAssistantResponse(items[7]!, 'running')).toBe(false);
    expect(assistantResponseCopyText(items, 3)).toBe('我先搜索\n\n请完成授权');
    expect(assistantResponseCopyText(items, 7)).toBe('我重新尝试\n\n这是最终结果');
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
      category: 'file',
      name: '修改文件',
      target: 'src/app.ts',
      status: 'succeeded',
      summary: '文件已更新',
      fileChange: { path: 'src/app.ts', additions: 18, deletions: 6 },
      rawOutput: '受控原始输出',
    } }));
    expect(screen.getByText('+18')).toBeInTheDocument();
    expect(screen.getByText('−6')).toBeInTheDocument();
    expect(screen.queryByText('受控原始输出')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '修改文件，展开输出内容' }));
    expect(screen.getByText('受控原始输出')).toBeInTheDocument();
    expect(screen.queryByText('opaque-ref')).not.toBeInTheDocument();
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
      breakdown: { systemPrompt: 500, workspaceCode: 1_000, recentConversation: 2_000, toolResults: 500, projectMemory: 300, toolDefinitions: 500, other: 200 },
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
