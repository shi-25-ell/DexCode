import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { conversationReducer } from './conversation-page';
import { ToolCard } from './tool-card';

vi.stubGlobal('crypto', { randomUUID: () => 'test-id' });

describe('conversationReducer', () => {
  it('keeps one Tool Card per opaque call reference without rendering that ref as content', () => {
    const initial = { items: [], contextUsage: { source: 'unknown' as const }, status: 'idle' as const, title: '新会话' };
    const running = conversationReducer(initial, { type: 'tool', tool: { callRef: 'call_hidden', category: 'file', name: '修改文件', target: 'src/app.ts', status: 'running', summary: '正在执行…' } });
    const completed = conversationReducer(running, { type: 'tool', tool: { callRef: 'call_hidden', category: 'file', name: '修改文件', target: 'src/app.ts', status: 'succeeded', summary: '文件已更新', fileChange: { path: 'src/app.ts', additions: 18, deletions: 6 } } });
    expect(completed.items).toHaveLength(1);
    expect(completed.items[0]).toMatchObject({ kind: 'tool', tool: { name: '修改文件', status: 'succeeded' } });
    expect(JSON.stringify(completed.items[0])).not.toContain('write_file');
  });

  it('does not create history state for an untouched draft', () => {
    const initial = { items: [], contextUsage: { source: 'unknown' as const }, status: 'idle' as const, title: '新会话' };
    expect(initial.items).toHaveLength(0);
    expect(initial.title).toBe('新会话');
  });

  it('renders file stats and keeps raw output behind an explicit disclosure', () => {
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
    fireEvent.click(screen.getByRole('button', { name: '修改文件，展开原始输出' }));
    expect(screen.getByText('受控原始输出')).toBeInTheDocument();
    expect(screen.queryByText('opaque-ref')).not.toBeInTheDocument();
  });
});
