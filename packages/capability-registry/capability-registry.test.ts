import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityRegistry } from './index.ts';

test('capability entries can be removed without changing Sidebar code', () => {
  const registry = createCapabilityRegistry({ disabled: ['project-knowledge'] });
  assert.equal(registry.has('snapshots'), false);
  assert.equal(registry.has('tools'), false);
  assert.deepEqual(registry.list().map((item) => item.id), ['mcp', 'skills', 'approval', 'memory']);
});
