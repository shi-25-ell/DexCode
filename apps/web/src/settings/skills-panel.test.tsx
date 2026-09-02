import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillsPanel } from './skills-panel';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Skill settings actions', () => {
  it('uses one semantic rescan action and reports completion', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const method = init?.method ?? 'GET';
      const body = method === 'POST' ? {} : { skills: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    render(<QueryClientProvider client={client}><SkillsPanel workspaceRef="workspace-1" /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: '重新扫描' })).toBeInTheDocument();
    expect(screen.getByText(/安装到全局目录，可供所有项目使用/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入 Skill' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/skills/reload', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByRole('status')).toHaveTextContent('扫描完成');
  });

  it('lets users delete a globally imported Skill', async () => {
    const skill = {
      name: 'shared-skill',
      description: 'Shared by every workspace.',
      source: 'user' as const,
      rootPath: 'C:\\Users\\tester\\.dexcode\\skills\\shared-skill',
      enabled: true,
      allowImplicitInvocation: false,
      userInvocable: true,
      tags: [],
      filePatterns: [],
      requiredCapabilities: [],
      missingCapabilities: [],
      shadowed: false,
      usage: { readCount: 0, activationCount: 0, lastUsedAt: null },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = init?.method === 'DELETE' ? { ok: true } : { skills: [skill] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    render(<QueryClientProvider client={client}><SkillsPanel workspaceRef="workspace-1" /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: '删除 shared-skill' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/skills/shared-skill', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ rootPath: skill.rootPath }),
    })));
  });
});
