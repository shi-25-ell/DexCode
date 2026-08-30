import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationItem } from '../types';
import { conversationReducer } from './conversation-page';
import { assistantResponseCopyText, isCompleteAssistantResponse } from './response-boundary';
import { ToolCard } from './tool-card';
import { ContextCard } from './context-card';

vi.stubGlobal('crypto', { randomUUID: () => 'test-id' });

describe('conversationReducer', () => {
  it('only marks the terminal assistant segment of each completed response as copyable', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user', content: '搜索仓库' },
      { id: 'a1', kind: 'assistant', content: '我先搜索' },
      { id: 't1', kind: 'tool', tool: { callRef: 'call-1', category: 'mcp', name: '调用 MCP', status: 'succeeded', summary: '完成' } },
      { id: 'a2', kind: 'assistant', content: '请完成授权' },
      { id: 'u2', kind: 'user', content: '授权完成' },
      { id: 'a3', kind: 'assistant', content: '我重新尝试' },
      { id: 't2', kind: 'tool', tool: { callRef: 'call-2', category: 'mcp', name: '调用 MCP', status: 'succeeded', summary: '完成' } },
      { id: 'a4', kind: 'assistant', content: '这是最终结果' },
    ];

    expect(items.map((_, index) => isCompleteAssistantResponse(items, index, 'idle'))).toEqual([false, false, false, true, false, false, false, true]);
    expect(isCompleteAssistantResponse(items, 7, 'running')).toBe(false);
    expect(assistantResponseCopyText(items, 3)).toBe('我先搜索\n\n请完成授权');
    expect(assistantResponseCopyText(items, 7)).toBe('我重新尝试\n\n这是最终结果');
  });

  it('does not expose a copy action before a pending approval', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user', content: '运行命令' },
      { id: 'a1', kind: 'assistant', content: '需要你的确认' },
      { id: 'p1', kind: 'approval', approvalRef: 'approval-1', approvalKind: 'command', title: '确认命令', options: ['allow_once', 'deny'] },
    ];

    expect(isCompleteAssistantResponse(items, 1, 'waiting')).toBe(false);
  });

  it('keeps one Tool Card per opaque call reference without rendering that ref as content', () => {
    const initial = { items: [], contextUsage: { source: 'unknown' as const, timing: 'next_request' as const }, status: 'idle' as const, title: '新会话' };
    const running = conversationReducer(initial, { type: 'tool', tool: { callRef: 'call_hidden', category: 'file', name: '修改文件', target: 'src/app.ts', status: 'running', summary: '正在执行…' } });
    const completed = conversationReducer(running, { type: 'tool', tool: { callRef: 'call_hidden', category: 'file', name: '修改文件', target: 'src/app.ts', status: 'succeeded', summary: '文件已更新', fileChange: { path: 'src/app.ts', additions: 18, deletions: 6 } } });
    expect(completed.items).toHaveLength(1);
    expect(completed.items[0]).toMatchObject({ kind: 'tool', tool: { name: '修改文件', status: 'succeeded' } });
    expect(JSON.stringify(completed.items[0])).not.toContain('write_file');
  });

  it('does not create history state for an untouched draft', () => {
    const initial = { items: [], contextUsage: { source: 'unknown' as const, timing: 'next_request' as const }, status: 'idle' as const, title: '新会话' };
    expect(initial.items).toHaveLength(0);
    expect(initial.title).toBe('新会话');
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
    const initial = { items: [], contextUsage: { source: 'unknown' as const, timing: 'next_request' as const }, status: 'running' as const, title: '会话' };
    const running = conversationReducer(initial, { type: 'context', context: { operationRef: 'context-1', status: 'running' } });
    const completed = conversationReducer(running, { type: 'context', context: {
      operationRef: 'context-1',
      status: 'completed',
      beforeTokens: 12_000,
      afterTokens: 5_000,
      archivedMessages: 18,
      archivedConversationSegments: 4,
      summarizedMessages: 0,
      breakdown: { systemPrompt: 500, workspaceCode: 1_000, recentConversation: 2_000, toolResults: 500, projectMemory: 300, toolDefinitions: 500, other: 200 },
    } });
    expect(completed.items).toHaveLength(1);
    expect(completed.items[0]).toMatchObject({ kind: 'context', context: { status: 'completed' } });

    render(createElement(ContextCard, { context: (completed.items[0] as Extract<ConversationItem, { kind: 'context' }>).context }));
    fireEvent.click(screen.getByRole('button', { name: /展开整理详情/ }));
    expect(screen.getByText(/18 条历史消息已归档/)).toBeInTheDocument();
    expect(screen.queryByText(/已生成对话摘要/)).not.toBeInTheDocument();
  });
});
