import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createExternalMcpRegistry } from './index.ts';

const fixture = fileURLToPath(new URL('./stdio-fixture.mjs', import.meta.url));

test('stdio MCP completes initialization before listing and calling tools', async () => {
  const registry = createExternalMcpRegistry([
    {
      name: 'fixture',
      type: 'stdio',
      command: process.execPath,
      args: [fixture],
    },
  ]);

  try {
    const [firstTools, secondTools] = await Promise.all([registry.listTools(), registry.listTools()]);
    assert.deepEqual(firstTools.map((tool) => tool.name), ['echo']);
    assert.deepEqual(secondTools.map((tool) => tool.name), ['echo']);
    assert.deepEqual(registry.getServerStatuses(), [
      {
        name: 'fixture',
        type: 'stdio',
        state: 'ready',
        toolCount: 1,
        protocolVersion: '2025-06-18',
        serverName: 'stdio-fixture',
      },
    ]);

    const result = await registry.callTool('mcp__fixture__echo', { text: 'ready' });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'ready' }] });
  } finally {
    await registry.removeServer('fixture');
  }
});

test('stdio MCP retains a server-scoped discovery error for the UI', async () => {
  const registry = createExternalMcpRegistry([
    { name: 'missing', type: 'stdio', command: `missing-mcp-${crypto.randomUUID()}` },
  ]);

  try {
    assert.deepEqual(await registry.listTools(), []);
    const [status] = registry.getServerStatuses();
    assert.equal(status?.state, 'error');
    assert.match(status?.error ?? '', /ENOENT|not found/i);
  } finally {
    await registry.removeServer('missing');
  }
});

test('registry close waits for a running stdio MCP child to exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-mcp-close-'));
  const marker = join(root, 'exited.txt');
  const registry = createExternalMcpRegistry([
    {
      name: 'fixture',
      type: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { MCP_EXIT_MARKER: marker },
    },
  ]);

  try {
    assert.equal((await registry.listTools()).length, 1);
    await registry.close();
    assert.match(await readFile(marker, 'utf8'), /^\d+$/);
    assert.deepEqual(registry.listServers(), []);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
