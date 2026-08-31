import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalModePanel } from './approval-mode-panel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ApprovalModePanel /></QueryClientProvider>);
}

describe('Approval mode settings', () => {
  it('keeps global mode available without a workspace and confirms full access', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const mode = init?.method === 'PUT' ? 'full_access' : 'allowlist';
      return new Response(JSON.stringify({ version: 1, mode, revision: mode === 'full_access' ? 1 : 0, updatedAt: '2026-08-31T00:00:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    renderPanel();

    expect(await screen.findByRole('radio', { name: /白名单模式/ })).toBeChecked();
    expect(screen.getByText('选择项目后管理命令白名单')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /完全访问/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/approval-mode', expect.objectContaining({ method: 'PUT' })));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('radio', { name: /完全访问/ })).toBeChecked();
  });

  it('keeps the server value selected when saving fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ error: '无法保存' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ version: 1, mode: 'allowlist', revision: 0, updatedAt: '2026-08-31T00:00:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    renderPanel();

    await screen.findByRole('radio', { name: /白名单模式/ });
    fireEvent.click(screen.getByRole('radio', { name: /只读模式/ }));
    expect(await screen.findByText('无法保存')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /白名单模式/ })).toBeChecked();
  });
});
