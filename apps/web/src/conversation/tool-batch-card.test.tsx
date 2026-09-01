import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPresentation } from '../types';
import { ToolBatchCard } from './tool-batch-card';

afterEach(cleanup);

function member(callRef: string, status: ToolPresentation['status'], overrides: Partial<ToolPresentation> = {}): ToolPresentation {
  return {
    callRef,
    toolName: 'read_file',
    category: 'read',
    name: '读取文件',
    target: `${callRef}.ts`,
    status,
    summary: status === 'failed' ? `无法读取 ${callRef}` : '已读取 2 行',
    ...overrides,
  };
}

describe('ToolBatchCard', () => {
  it('shows partial failures and their errors while folded', () => {
    render(createElement(ToolBatchCard, { batch: {
      id: 'tool-batch-inspection-ok',
      type: 'inspection',
      members: [member('ok', 'succeeded'), member('bad', 'failed')],
    } }));
    expect(screen.getByText('部分失败')).toBeInTheDocument();
    expect(screen.getByText('1 项异常')).toBeInTheDocument();
    expect(screen.getByText(/bad\.ts：无法读取 bad/)).toBeInTheDocument();
  });

  it('uses the full failure state only when every member failed', () => {
    render(createElement(ToolBatchCard, { batch: {
      id: 'tool-batch-inspection-failed',
      type: 'inspection',
      members: [member('bad-1', 'failed'), member('bad-2', 'failed')],
    } }));
    expect(screen.getByText('全部失败')).toBeInTheDocument();
    expect(document.querySelector('.tool-batch-card.failed')).not.toBeNull();
  });

  it('keeps invalid arguments and policy blocks distinct', () => {
    render(createElement(ToolBatchCard, { batch: {
      id: 'tool-batch-invalid', type: 'inspection', members: [member('bad-input', 'invalid', { summary: 'offset 必须大于 0' })],
    } }));
    expect(screen.getByText('参数错误')).toBeInTheDocument();
    expect(document.querySelector('.tool-batch-card.invalid')).not.toBeNull();
    cleanup();

    render(createElement(ToolBatchCard, { batch: {
      id: 'tool-batch-blocked', type: 'inspection', members: [member('blocked', 'blocked', { summary: '策略阻止' })],
    } }));
    expect(screen.getByText('已阻止')).toBeInTheDocument();
    expect(document.querySelector('.tool-batch-card.blocked')).not.toBeNull();
  });

  it('keeps repeated file operations in call order and reveals their real diffs', () => {
    const change = (text: string) => ({
      path: 'same.ts', kind: 'modified' as const, additions: 1, deletions: 1,
      diff: `--- a/same.ts\n+++ b/same.ts\n@@ -1 +1 @@\n-${text}\n+${text.toUpperCase()}\n`, truncated: false,
    });
    render(createElement(ToolBatchCard, { batch: {
      id: 'tool-batch-modification-first',
      type: 'modification',
      members: [
        member('first', 'succeeded', { toolName: 'patch_file', category: 'file', name: '修改文件', target: 'same.ts', fileChange: change('first') }),
        member('second', 'succeeded', { toolName: 'write_file', category: 'file', name: '修改文件', target: 'same.ts', fileChange: change('second') }),
      ],
    } }));
    fireEvent.click(screen.getByRole('button', { name: /修改文件，展开批次详情/ }));
    expect(screen.getAllByText('same.ts')).toHaveLength(2);
    const operationButtons = screen.getAllByRole('button').filter((button) => button.getAttribute('aria-expanded') === 'false');
    fireEvent.click(operationButtons[1]!);
    expect(screen.getByText(/-second\s+\+SECOND/)).toBeInTheDocument();
  });

  it('shows every command execution and approval outcome', () => {
    render(createElement(ToolBatchCard, { batch: {
      id: 'tool-batch-command-first', type: 'command', members: [
        member('first', 'succeeded', { toolName: 'run_command', category: 'command', name: '执行命令', target: 'npm test', approval: { status: 'approved', addedToWhitelist: true } }),
        member('second', 'failed', { toolName: 'run_command', category: 'command', name: '执行命令', target: 'npm run lint', approval: { status: 'denied', addedToWhitelist: false } }),
      ],
    } }));
    expect(screen.getByText('执行了 2 个命令操作 · 异常 1 个')).toBeInTheDocument();
    expect(screen.getByText('部分失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '执行命令，展开批次详情' }));
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('npm run lint')).toBeInTheDocument();
    expect(screen.getByText('已批准')).toBeInTheDocument();
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
    expect(screen.getByText('加入白名单：是')).toBeInTheDocument();
    expect(screen.getByText('加入白名单：否')).toBeInTheDocument();
  });
});
