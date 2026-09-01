import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectKnowledgePanel } from './project-knowledge-panel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Project knowledge settings', () => {
  it('reads and writes DEXCODE.md through the project knowledge API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ updatedAt: '2026-09-02T00:00:00.000Z' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ content: '# 项目知识\n', path: 'DEXCODE.md', exists: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><ProjectKnowledgePanel workspaceRef="workspace-1" /></QueryClientProvider>);

    const editor = await screen.findByRole('textbox', { name: '项目知识内容' });
    await waitFor(() => expect(editor).toHaveValue('# 项目知识\n'));
    expect(screen.getAllByText(/DEXCODE\.md/)).toHaveLength(2);
    fireEvent.change(editor, { target: { value: '# 项目知识\n\n- 使用 pnpm' } });
    fireEvent.click(screen.getByRole('button', { name: '保存项目知识' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/project-knowledge', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ content: '# 项目知识\n\n- 使用 pnpm' }),
    })));
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/project-memory')).toBe(false);
  });
});
