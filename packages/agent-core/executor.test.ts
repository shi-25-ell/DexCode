import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutor } from './executor.ts';
import type { ModelClient } from '../llm-client/index.ts';

test('stops ReAct loop at configured maxIterations', async () => {
  let calls = 0;
  const modelClient: ModelClient = {
    model: 'mock',
    baseUrl: '',
    createMessage: async () => {
      calls++;
      return {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `call-${calls}`,
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    },
    streamMessage: async function* () {},
  };
  const executor = createExecutor({
    readFile: () => ({ path: 'a.ts', content: 'x' }),
    writeFile: () => null,
    runCommand: () => null,
    listWorkspace: () => [],
    searchInWorkspace: () => [],
    patchFile: () => null,
    listVersions: () => [],
    createSnapshot: () => null,
    restoreSnapshot: () => null,
  });

  await executor.runReActLoop(modelClient, [], () => {}, undefined, { maxIterations: 2 });

  assert.equal(calls, 2);
});

test('records fileChanges for write_file calls', async () => {
  const modelClient: ModelClient = {
    model: 'mock',
    baseUrl: '',
    createMessage: async (messages: unknown[]) => {
      const hasToolResult = JSON.stringify(messages).includes('"role":"tool"');
      if (hasToolResult) {
        return { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };
      }
      return {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: '{"path":"a.ts","content":"after"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    },
    streamMessage: async function* () {},
  };
  let content = 'before';
  const executor = createExecutor({
    readFile: (path: string) => ({ path, content }),
    writeFile: (_path: string, next: string) => {
      content = next;
      return { ok: true };
    },
    runCommand: () => null,
    listWorkspace: () => [],
    searchInWorkspace: () => [],
    patchFile: () => null,
    listVersions: () => [],
    createSnapshot: () => null,
    restoreSnapshot: () => null,
  });

  const result = await executor.runReActLoop(modelClient, [], () => {});

  assert.deepEqual(result.filesModified, ['a.ts']);
  assert.deepEqual(result.fileChanges, [{ path: 'a.ts', before: 'before', after: 'after' }]);
});
