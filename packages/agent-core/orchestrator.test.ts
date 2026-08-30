import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelClient } from '../llm-client/index.ts';
import type { ChatMessage } from '../shared/types.ts';
import { classifyTask, createOrchestrator } from './orchestrator.ts';

test('classifies compound prompts before read-heavy prompts', () => {
  const result = classifyTask('Analyze auth flow and fix security issue and write tests', [
    'src/auth.ts',
    'src/auth.test.ts',
  ]);

  assert.equal(result.type, 'compound');
  assert.equal(result.subTasks?.length, 3);
});

test('classifies analysis prompts as read-heavy with read targets', () => {
  const result = classifyTask('review src/auth.ts, src/routes/user.ts auth flow', [
    'src/auth.ts',
    'src/routes/user.ts',
  ]);

  assert.equal(result.type, 'read-heavy');
  assert.deepEqual(result.readTargets, ['src/auth.ts', 'src/routes/user.ts']);
});

test('classifies Chinese multi-file analysis prompts as compound', () => {
  const result = classifyTask('分析hotwords.py，解释sensevoice.py，并总结builder.py', [
    'stt/hotwords.py',
    'stt/sensevoice.py',
    'kb/builder.py',
  ]);

  assert.equal(result.type, 'compound');
  assert.equal(result.subTasks?.length, 3);
});

test('classifies focused edit prompts as code-only', () => {
  const result = classifyTask('Change validateToken in auth.ts to async', ['src/auth.ts']);

  assert.equal(result.type, 'code-only');
  assert.equal(result.subTasks, undefined);
});

test('prefetches referenced files before running compound subtasks', async () => {
  const seenMessages: ChatMessage[][] = [];
  const modelClient: ModelClient = {
    model: 'mock',
    baseUrl: '',
    createMessage: async () => ({}),
    streamMessage: async function* () {},
  };
  const codingToolHost = {
    listWorkspace: () => [
      { path: 'packages/agent-core/orchestrator.ts' },
      { path: 'packages/agent-core/worker-pool.ts' },
      { path: 'packages/agent-core/review-agent.ts' },
    ],
    readFile: (path: string) => ({ path, content: `content:${path}` }),
    searchInWorkspace: () => [],
  };
  const executor = {
    runReActLoop: async (_llm: ModelClient, messages: ChatMessage[]) => {
      seenMessages.push(messages);
      return {
        messages: [{ role: 'assistant' as const, content: 'ok' }],
        finalContent: 'ok',
        toolsUsed: [],
        filesModified: [],
        fileChanges: [],
      };
    },
  };
  const prompt = [
    'Analyze packages/agent-core/orchestrator.ts',
    'and explain packages/agent-core/worker-pool.ts',
    'and summarize packages/agent-core/review-agent.ts',
  ].join(' ');

  const result = await createOrchestrator(codingToolHost, executor, modelClient)
    .run('task-1', prompt, [], () => {});

  assert.equal(result.trace.classifiedAs, 'compound');
  assert.equal(result.trace.workerTaskCount, 3);
  assert.equal(result.trace.subTaskCount, 3);
  assert.equal(seenMessages.length, 3);
  assert.match(JSON.stringify(seenMessages[0]), /WORKER read_file/);
  assert.match(JSON.stringify(seenMessages[0]), /content:packages\/agent-core\/orchestrator\.ts/);
});
