import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubagentsPanel } from './subagents-panel';
import type { SubagentDefinition, SubagentDefinitionsResponse } from './types';

const builtins: SubagentDefinition[] = [
  { name: 'researcher', description: 'Research', instructions: 'Research.', filePermission: 'read_only', contextMode: 'fresh', source: 'builtin', enabled: true, editable: false, toggleable: true, deletable: false },
  { name: 'reviewer', description: 'Review', instructions: 'Review.', filePermission: 'read_only', contextMode: 'fork', source: 'builtin', enabled: true, editable: false, toggleable: true, deletable: false },
];

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderPanel(response: SubagentDefinitionsResponse) {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const method = init?.method ?? 'GET';
    const body = method === 'GET' ? response : { agent: response.agents[0] };
    return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><SubagentsPanel /></QueryClientProvider>);
  return fetchMock;
}

describe('Subagent settings', () => {
  it('protects built-ins and supports create and toggle operations', async () => {
    const custom: SubagentDefinition = { name: 'test-writer', description: 'Write tests', instructions: 'Add focused tests.', filePermission: 'write_files', contextMode: 'fork', source: 'user', enabled: true, editable: true, toggleable: true, deletable: true };
    const fetchMock = renderPanel({ agents: [...builtins, custom], limit: 10, customLimit: 10, diagnostics: [] });

    expect(await screen.findByText('1/10')).toBeInTheDocument();
    expect(screen.getByText('你可以在这里预定义一些子智能体，也可以在对话时让模型按需生成。')).toBeInTheDocument();
    expect(screen.queryByText('general-purpose')).not.toBeInTheDocument();
    expect(document.querySelector('.subagent-grid')).toBeInTheDocument();
    expect(document.querySelectorAll('.subagent-card')).toHaveLength(3);
    expect(document.querySelectorAll('.subagent-avatar')).toHaveLength(3);
    expect(screen.queryByText('assistant')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'researcher：已启用' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /编辑/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /删除/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'researcher：已启用' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/agent-definitions/researcher', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) })));

    fireEvent.click(screen.getByRole('button', { name: '新建子智能体' }));
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: 'docs-agent' } });
    fireEvent.change(screen.getByLabelText('使用场景描述'), { target: { value: 'Write documentation' } });
    fireEvent.change(screen.getByLabelText('子智能体指令'), { target: { value: 'Update the requested documentation.' } });
    fireEvent.change(screen.getByLabelText('文件权限'), { target: { value: 'write_files' } });
    fireEvent.change(screen.getByLabelText('上下文'), { target: { value: 'fresh' } });
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/agent-definitions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'docs-agent', description: 'Write documentation', instructions: 'Update the requested documentation.', filePermission: 'write_files', contextMode: 'fresh' }),
    })));
  });

  it('disables creation when the total limit is reached', async () => {
    const customs = Array.from({ length: 10 }, (_, index): SubagentDefinition => ({ name: `custom-${index}`, description: 'Custom', instructions: 'Work.', filePermission: 'read_only', contextMode: 'fork', source: 'user', enabled: true, editable: true, toggleable: true, deletable: true }));
    renderPanel({ agents: [...builtins, ...customs], limit: 10, customLimit: 10, diagnostics: [] });
    expect(await screen.findByText('10/10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建子智能体' })).toBeDisabled();
  });
});
