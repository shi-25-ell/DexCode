import { describe, expect, it } from 'vitest';
import { describeMcpStatus } from './mcp-panel';

describe('MCP settings status', () => {
  it('shows protocol discovery failures instead of reporting zero tools', () => {
    expect(describeMcpStatus(
      { name: 'GitHub', type: 'stdio', command: 'wsl.exe', enabled: true },
      { name: 'GitHub', type: 'stdio', state: 'error', toolCount: 0, error: 'initialize required' },
      false,
    )).toEqual({ tone: 'error', text: '连接失败：initialize required' });
  });

  it('shows negotiated protocol and tool count for a ready server', () => {
    expect(describeMcpStatus(
      { name: 'GitHub', type: 'stdio', command: 'wsl.exe', enabled: true },
      { name: 'GitHub', type: 'stdio', state: 'ready', toolCount: 42, protocolVersion: '2025-06-18' },
      false,
    )).toEqual({ tone: 'normal', text: '已连接 · 42 个工具 · MCP 2025-06-18' });
  });
});
