import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApprovalMode, ToolApprovalRequest } from '../shared/types.ts';
import { createCodingToolHost } from './index.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dex-tool-approval-'));
  const projectDir = join(root, 'state');
  let content = 'before';
  let mode: ApprovalMode = 'allowlist';
  const host = createCodingToolHost({
    rootDir: root,
    projectId: 'workspace-test',
    projectDir,
    getRootDir: () => root,
    findFile: (path) => path === 'a.ts' ? { id: 'a.ts', name: 'a.ts', path: 'a.ts', type: 'file', content } : null,
    updateFile: async (path, next) => { content = next; return { ok: true, path }; },
    listTree: () => [],
    listFiles: () => [],
    patchFile: async (input) => { content = JSON.stringify(input); return { ok: true }; },
    loadFromDisk: async () => [],
  }, { approvalModeStore: { getMode: () => mode } });
  return {
    root,
    host,
    read: () => content,
    setMode: (next: ApprovalMode) => { mode = next; },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('live approval mode is read for each tool authorization', async () => {
  const item = await fixture();
  try {
    let requests = 0;
    const approve = async (request: ToolApprovalRequest) => {
      requests += 1;
      return { decision: 'allow_once' as const, fingerprint: request.fingerprint };
    };
    item.setMode('read_only');
    await item.host.executeAgentTool('write_file', { path: 'a.ts', content: 'read-only-approved' }, { origin: 'agent', onApproval: approve });
    assert.equal(requests, 1);
    item.setMode('full_access');
    await item.host.executeAgentTool('write_file', { path: 'a.ts', content: 'full-access' }, { origin: 'agent', onApproval: approve });
    assert.equal(requests, 1);
    assert.equal(item.read(), 'full-access');
  } finally {
    await item.cleanup();
  }
});

test('MCP exposes the same exact ten-tool registry and rejects removed calls', async () => {
  const item = await fixture();
  try {
    assert.deepEqual(item.host.mcp.listTools().map((tool) => tool.name), [
      'find', 'ls', 'list_workspace', 'read_file', 'grep', 'run_command', 'patch_file', 'write_file', 'read_command_output', 'stop_command',
    ]);
    assert.match(String(item.host.mcp.validateToolCall('search_in_workspace', {})), /not found/i);
  } finally {
    await item.cleanup();
  }
});

test('read_file model contract reaches the paginated disk implementation unchanged', async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, 'sample.txt'), 'one\ntwo\nthree\n', 'utf8');
    const result = await item.host.executeAgentTool('read_file', { path: 'sample.txt', offset: 2, limit: 1 }, { origin: 'agent' }) as Record<string, unknown>;
    assert.equal(result.content, 'two');
    assert.equal(result.start_line, 2);
    assert.equal(result.end_line, 2);
    assert.equal(result.next_offset, 3);

    const invalid = await item.host.executeAgentTool('read_file', { path: 'sample.txt', offset: 0 }, { origin: 'agent' }) as {
      status: string;
      error: { code: string };
    };
    assert.equal(invalid.status, 'invalid_arguments');
    assert.equal(invalid.error.code, 'INVALID_ARGUMENTS');
  } finally {
    await item.cleanup();
  }
});

test('allowlist mode permits file writes but asks for an ordinary command', async () => {
  const item = await fixture();
  try {
    const requests: ToolApprovalRequest[] = [];
    await item.host.executeAgentTool('write_file', { path: 'a.ts', content: 'after' }, { origin: 'agent' });
    const result = await item.host.executeAgentTool('run_command', { command: 'node -p 1+1' }, {
      origin: 'agent',
      onApproval: async (request) => {
        requests.push(request);
        return { decision: 'allow_once', fingerprint: request.fingerprint };
      },
    }) as { status: string; stdout?: string };
    assert.equal(item.read(), 'after');
    assert.equal(requests[0]?.options.includes('allow_whitelist'), true);
    assert.equal(result.status, 'success');
    assert.equal(result.stdout, '2');
  } finally {
    await item.cleanup();
  }
});

test('approval is bound to its fingerprint and exact whitelist additions apply immediately', async () => {
  const item = await fixture();
  try {
    item.setMode('read_only');
    const denied = await item.host.executeAgentTool('write_file', { path: 'a.ts', content: 'changed' }, {
      origin: 'agent',
      onApproval: async () => ({ decision: 'allow_once', fingerprint: 'wrong' }),
    }) as { status: string };
    assert.equal(denied.status, 'denied');
    assert.equal(item.read(), 'before');

    let requests = 0;
    const first = await item.host.executeAgentTool('run_command', { command: 'node -p 2+2' }, {
      origin: 'agent',
      onApproval: async (request) => {
        requests += 1;
        return { decision: 'allow_whitelist', fingerprint: request.fingerprint };
      },
    }) as { status: string };
    assert.equal(first.status, 'success');
    const second = await item.host.executeAgentTool('run_command', { command: 'node -p 2+2' }, { origin: 'agent' }) as { status: string };
    assert.equal(second.status, 'success');
    assert.equal(requests, 1);
    const entries = await item.host.commandWhitelist.list();
    assert.equal(entries.some((entry) => entry.matchType === 'exact' && entry.pattern === 'node -p 2+2'), true);
  } finally {
    await item.cleanup();
  }
});

test('hard guards and missing approval channels fail closed', async () => {
  const item = await fixture();
  try {
    item.setMode('full_access');
    const blocked = await item.host.executeAgentTool('run_command', { command: 'Remove-Item -Recurse C:\\' }, { origin: 'agent' }) as { status: string };
    assert.equal(blocked.status, 'blocked');
    const outside = await item.host.executeAgentTool('write_file', { path: '../outside.ts', content: 'x' }, { origin: 'agent' }) as { status: string };
    assert.equal(outside.status, 'blocked');

    item.setMode('allowlist');
    const external = await item.host.executeAgentTool('mcp__docs__mutate', { secret: 'hidden' }, {
      origin: 'mcp_http',
      executeExternal: async () => ({ ok: true }),
    }) as { status: string };
    assert.equal(external.status, 'denied');
  } finally {
    await item.cleanup();
  }
});

test('an issued approval remains pending when the global mode changes', async () => {
  const item = await fixture();
  try {
    item.setMode('read_only');
    let release: ((value: { decision: 'allow_once'; fingerprint: string }) => void) | undefined;
    let requestedFingerprint = '';
    const execution = item.host.executeAgentTool('write_file', { path: 'a.ts', content: 'after' }, {
      origin: 'agent',
      onApproval: (request) => {
        requestedFingerprint = request.fingerprint;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    item.setMode('full_access');
    assert.equal(item.read(), 'before');
    release?.({ decision: 'allow_once', fingerprint: requestedFingerprint });
    await execution;
    assert.equal(item.read(), 'after');
  } finally {
    await item.cleanup();
  }
});

test('MCP HTTP tool calls use the same policy and fail closed without an approval channel', async () => {
  const item = await fixture();
  try {
    item.setMode('read_only');
    const denied = await item.host.mcpJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'write_file', arguments: { path: 'a.ts', content: 'denied' } },
    });
    assert.equal(Boolean(denied && 'error' in denied), true);
    assert.equal(item.read(), 'before');

    item.setMode('allowlist');
    const allowed = await item.host.mcpJsonRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'write_file', arguments: { path: 'a.ts', content: 'allowed' } },
    });
    assert.equal(Boolean(allowed && 'result' in allowed), true);
    assert.equal(item.read(), 'allowed');
  } finally {
    await item.cleanup();
  }
});
