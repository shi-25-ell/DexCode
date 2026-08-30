import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createExternalMcpConfigStore } from './config-store.ts';

test('external MCP config store uses the environment fallback until a persisted document exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-mcp-'));
  try {
    const store = createExternalMcpConfigStore({ file: join(root, 'servers.json') });
    const fallback = [{ name: 'docs', type: 'http' as const, url: 'https://example.test/mcp' }];
    assert.deepEqual(await store.read(fallback), fallback);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external MCP config store persists disabled and stdio server details atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-mcp-'));
  try {
    const file = join(root, 'servers.json');
    const store = createExternalMcpConfigStore({ file });
    const servers = [{ name: 'local', type: 'stdio' as const, command: 'npx', args: ['server'], env: { TOKEN: 'secret' }, enabled: false }];
    await store.write(servers);
    assert.deepEqual(await store.read(), servers);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, servers });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
