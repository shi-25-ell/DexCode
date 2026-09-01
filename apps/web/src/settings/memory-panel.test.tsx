import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPanel } from './memory-panel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function snapshot(enabled = true, topicCount = 2) {
  return {
    workspaceId: 'workspace-1', mode: 'on', topicCount, indexExists: true, totalBytes: 100, degraded: false, diagnostics: [],
    settings: { version: 1, enabled, extractionEnabled: true, recallEnabled: true, consolidationEnabled: false, extractionEveryCompletedRuns: 1, consolidationMinHours: 24, consolidationMinSessions: 5, generation: 1 },
  };
}

describe('Memory settings', () => {
  it('toggles the project-wide switch and clears only after confirmation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') return new Response(JSON.stringify(snapshot(false).settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ deletedFiles: 3, releasedBytes: 100, generation: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryPanel workspaceRef="workspace-1" /></QueryClientProvider>);

    const toggle = await screen.findByRole('button', { name: '启用记忆：已启用' });
    expect(screen.queryByText(/当前项目：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/记忆主题/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/managed-memory/settings', expect.objectContaining({ method: 'PUT' })));

    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByRole('dialog', { name: '清空记忆' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/managed-memory', expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '清空记忆' })).not.toBeInTheDocument());
  });
});
