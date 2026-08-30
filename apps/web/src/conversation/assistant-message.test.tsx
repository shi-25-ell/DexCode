import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from './assistant-message';

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(cleanup);

describe('AssistantMessage', () => {
  it('keeps long links breakable and wraps GFM tables in a local scroll region', () => {
    const longUrl = 'https://example.com/oauth/authorize?client_id=client&code_challenge=an-extremely-long-unbroken-value';
    const content = `${longUrl}\n\n| 编号 | 标题 | 创建时间 |\n| --- | --- | --- |\n| #3181 | A very long issue title | 2026-08-29 |`;
    render(<AssistantMessage content={content} />);

    expect(screen.getByRole('link', { name: longUrl })).toHaveAttribute('href', longUrl);
    const table = screen.getByRole('table');
    expect(table.parentElement).toHaveClass('markdown-table-scroll');
    expect(screen.getByRole('region', { name: '表格，可横向滚动' })).toContainElement(table);
  });

  it('copies the complete Markdown source and confirms success', async () => {
    const content = '# 回答标题\n\n```ts\nconst value = 1;\n```';
    render(<AssistantMessage content={content} />);

    fireEvent.click(screen.getByRole('button', { name: '复制回答' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(content));
    expect(screen.getByRole('button', { name: '已复制回答' })).toBeInTheDocument();
    expect(screen.getByText('已复制')).toBeInTheDocument();
  });

  it('shows a retryable failure state when clipboard access fails', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    render(<AssistantMessage content="回答内容" />);

    fireEvent.click(screen.getByRole('button', { name: '复制回答' }));

    expect(await screen.findByRole('button', { name: '复制失败，重试复制回答' })).toBeInTheDocument();
    expect(screen.getByText('复制失败')).toBeInTheDocument();
  });
});
