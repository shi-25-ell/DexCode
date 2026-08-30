import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkerPool } from './worker-pool.ts';

test('runs read-only worker tasks with concurrency limit three', async () => {
  let active = 0;
  let peak = 0;
  const gateway = {
    readFile: async (path: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { path, content: path };
    },
    searchInWorkspace: () => [],
    listWorkspace: () => [],
  };

  const results = await runWorkerPool(gateway, [
    { tool: 'read_file', params: { path: 'a.ts' } },
    { tool: 'read_file', params: { path: 'b.ts' } },
    { tool: 'read_file', params: { path: 'c.ts' } },
    { tool: 'read_file', params: { path: 'd.ts' } },
  ]);

  assert.equal(results.length, 4);
  assert.equal(peak, 3);
});

test('rejects non-whitelisted worker tools without calling gateway', async () => {
  let called = false;
  const gateway = {
    readFile: () => {
      called = true;
      return null;
    },
    searchInWorkspace: () => [],
    listWorkspace: () => [],
  };

  const [result] = await runWorkerPool(gateway, [
    { tool: 'write_file' as never, params: { path: 'a.ts' } },
  ]);

  assert.equal(called, false);
  assert.match(result.error ?? '', /not allowed/);
});

test('returns timeout errors without failing other worker tasks', async () => {
  const gateway = {
    readFile: async (path: string) => {
      if (path === 'slow.ts') {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return { path, content: path };
    },
    searchInWorkspace: () => [],
    listWorkspace: () => [],
  };

  const results = await runWorkerPool(gateway, [
    { tool: 'read_file', params: { path: 'slow.ts' } },
    { tool: 'read_file', params: { path: 'fast.ts' } },
  ], 3, 5);

  assert.match(results[0].error ?? '', /timeout/);
  assert.equal(results[1].error, undefined);
});
