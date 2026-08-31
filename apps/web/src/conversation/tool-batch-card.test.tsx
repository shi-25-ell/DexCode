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
    expect(screen.getByText('1 项失败')).toBeInTheDocument();
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
});
