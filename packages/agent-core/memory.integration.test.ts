import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createMockModelClient, type ChatOptions, type ModelClient, type ModelEvent, type ModelResponse } from '../llm-client/index.ts';
import { createManagedMemorySystem } from '../managed-memory/index.ts';
import { createSessionRepository } from '../session-store/index.ts';
import type { ChatMessage } from '../shared/types.ts';
import { createCodingAgent } from './index.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

const response = (content: string, toolCalls: ModelResponse['toolCalls'] = []): ModelResponse => ({
  content, reasoning: '', toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
});

function model(run: (messages: ChatMessage[], options?: ChatOptions) => Promise<ModelResponse>): ModelClient {
  return {
    ...createMockModelClient(), model: 'selected-model',
    async *streamMessage(messages, options): AsyncIterable<ModelEvent> {
      yield { version: 1, type: 'turn_started', attemptId: crypto.randomUUID() };
      const result = await run(messages as ChatMessage[], options);
      if (result.content) yield { version: 1, type: 'text_delta', delta: result.content };
      for (const [index, call] of result.toolCalls.entries()) yield { version: 1, type: 'tool_call_delta', index, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) };
      yield { version: 1, type: 'turn_completed', response: result };
    },
  };
}

const contextManager = { buildForPrompt: async (prompt: string) => ({ prompt, selectedFile: null, selectedFileContent: null, workspaceSummary: 'workspace-context', contextBudget: { includedFiles: [], maxChars: 0, maxFiles: 0 } }) };
const host = {
  readFile: () => ({ content: 'file result' }), writeFile: () => ({ ok: true }), runCommand: () => ({ ok: true }),
  listWorkspace: () => [], find: () => ({ paths: [] }), ls: () => ({ entries: [] }), grep: () => ({ match_count: 0, output: '' }), patchFile: () => ({ ok: true }),
};
const isExtraction = (messages: ChatMessage[]) => messages.some((item) => item.role === 'user' && item.content.startsWith('# Memory Extraction'));

test('completed main Runs fork actual model context without waiting or persisting hidden extraction Runs', async () => {
  const previous = process.env.CONTEXT_COMPACTION_STRATEGY;
  try {
    for (const strategy of ['legacy', 'four_layer']) {
      process.env.CONTEXT_COMPACTION_STRATEGY = strategy;
      const root = await mkdtemp(join(tmpdir(), 'dexcode-memory-runtime-'));
      const repository = createSessionRepository({ projectId: `test-memory-runtime-${crypto.randomUUID()}` });
      const scope = { kind: 'workspace' as const, workspaceId: 'workspace-memory-test' };
      const session = await repository.createSession(scope);
      const blocked = deferred();
      const entered = deferred();
      const mainRequests: ChatMessage[][] = [];
      const backgroundRequests: ChatMessage[][] = [];
      const metrics: Record<string, unknown>[] = [];
      const selected = model(async (messages, options) => {
        if (isExtraction(messages)) {
          backgroundRequests.push(structuredClone(messages));
          const tools = (options?.tools ?? []) as Array<{ function: { name: string } }>;
          assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ['memory_list', 'memory_read', 'memory_remove', 'memory_search', 'memory_upsert']);
          if (backgroundRequests.length === 1) { entered.resolve(); await blocked.promise; }
          return response('No useful new memory');
        }
        mainRequests.push(structuredClone(messages));
        return response('same answer');
      });
      const memory = createManagedMemorySystem({ workspaceId: scope.workspaceId, workspaceStateDir: root, modelClient: selected, observe: (event) => metrics.push(event) });
      const defaultModel = model(async () => { throw new Error('default model must not run'); });
      const agent = createCodingAgent(contextManager, host, defaultModel, repository, undefined, undefined, { scope, rootPath: root }, memory, { resolveModel: (id) => id === 'chosen' ? selected : defaultModel });
      try {
        const first = await agent.runTask(session.sessionId, 'hello', null, () => {}, async () => 'cancel', { model: 'chosen', runId: 'first', signal: AbortSignal.timeout(5_000) });
        assert.equal(first.status, 'completed');
        await entered.promise;
        const second = await agent.runTask(session.sessionId, 'another question', null, () => {}, async () => 'cancel', { model: 'chosen', runId: 'second', signal: AbortSignal.timeout(5_000) });
        assert.equal(second.status, 'completed');
        assert.equal(backgroundRequests.length, 1, 'second main Run must finish while extraction is still blocked');
        blocked.resolve();
        assert.equal((await memory.drain()).completed, true);
        assert.equal(backgroundRequests.length, 2);
        for (let i = 0; i < 2; i += 1) {
          assert.deepEqual(backgroundRequests[i]!.slice(0, -2), mainRequests[i]);
          assert.deepEqual(backgroundRequests[i]!.at(-2), { role: 'assistant', content: 'same answer' });
          assert.equal(backgroundRequests[i]!.at(-1)?.role, 'user');
        }
        assert.equal(metrics.filter((event) => event.type === 'managed_memory.extraction.started').at(-1)?.newMessageCount, 2);
        const loaded = await repository.loadSession(session.sessionId);
        assert.equal(loaded?.runReports?.length, 2);
        assert.equal(loaded?.messages.length, 4);
        assert.equal(loaded?.ledger?.some((record) => 'runId' in record && record.runId.startsWith('memory-')), false);
        await assert.rejects(readFile(memory.store.paths.checkpoints), { code: 'ENOENT' });
      } finally {
        blocked.resolve(); await memory.drain({ timeoutMs: 1_000 });
        await rm(root, { recursive: true, force: true });
        await rm(dirname(repository.sessionsDir), { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_COMPACTION_STRATEGY;
    else process.env.CONTEXT_COMPACTION_STRATEGY = previous;
  }
});

test('main model starts during recall selection and consumes ready topics only at the next model boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-memory-prefetch-'));
  const repository = createSessionRepository({ projectId: `test-memory-prefetch-${crypto.randomUUID()}` });
  const scope = { kind: 'workspace' as const, workspaceId: 'workspace-prefetch-test' };
  const session = await repository.createSession(scope);
  const selectedTopics = deferred();
  const ready = deferred();
  let selectorCalls = 0;
  let mainCalls = 0;
  let selectorSignal: AbortSignal | undefined;
  const selected = model(async (messages) => {
    if (isExtraction(messages)) return response('done');
    mainCalls += 1;
    if (mainCalls === 1) {
      assert.equal(selectorCalls, 1);
      assert.equal(JSON.stringify(messages).includes('## Relevant Managed Memory'), false);
      selectedTopics.resolve();
      await ready.promise;
      return response('', [{ id: 'read-file', name: 'read_file', arguments: { path: 'README.md' } }]);
    }
    assert.match(JSON.stringify(messages), /private-memory-body/);
    return response('done');
  });
  const memory = createManagedMemorySystem({
    workspaceId: scope.workspaceId, workspaceStateDir: root, modelClient: selected,
    selector: { async select(input) { selectorCalls += 1; selectorSignal = input.signal; await selectedTopics.promise; return ['feedback.md']; } },
    observe: (event) => { if (event.type === 'managed_memory.recall.completed') ready.resolve(); },
  });
  try {
    await memory.store.upsert({ workspaceId: scope.workspaceId, actor: 'user', path: 'feedback.md', name: 'testing', description: 'tests', type: 'feedback', body: 'private-memory-body', indexTitle: 'testing', indexHook: 'tests', expectedDigest: null, operationId: 'fixture' });
    const agent = createCodingAgent(contextManager, host, selected, repository, undefined, undefined, { scope, rootPath: root }, memory);
    const result = await agent.runTask(session.sessionId, 'read README', null, () => {}, async () => 'confirm', { signal: AbortSignal.timeout(5_000) });
    assert.equal(result.status, 'completed');
    assert.equal(mainCalls, 2);
    assert.equal(selectorCalls, 1);
    assert.equal(selectorSignal?.aborted, true);
    assert.equal((await repository.loadSession(session.sessionId))?.runReports?.at(-1)?.managedMemoryRefs?.some((ref) => ref.path === 'feedback.md'), true);
  } finally {
    selectedTopics.resolve(); ready.resolve(); await memory.drain({ timeoutMs: 1_000 });
    await rm(root, { recursive: true, force: true });
    await rm(dirname(repository.sessionsDir), { recursive: true, force: true });
  }
});

test('hidden extraction stops after five model turns and leaves the successful main Run intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-memory-budget-'));
  const repository = createSessionRepository({ projectId: `test-memory-budget-${crypto.randomUUID()}` });
  const scope = { kind: 'workspace' as const, workspaceId: 'workspace-budget-test' };
  const session = await repository.createSession(scope);
  let extractionCalls = 0;
  const selected = model(async (messages) => {
    if (!isExtraction(messages)) return response('done');
    extractionCalls += 1;
    return response('', [{ id: `list-${extractionCalls}`, name: 'memory_list', arguments: {} }]);
  });
  const events: Record<string, unknown>[] = [];
  const memory = createManagedMemorySystem({ workspaceId: scope.workspaceId, workspaceStateDir: root, modelClient: selected, observe: (event) => events.push(event) });
  try {
    const agent = createCodingAgent(contextManager, host, selected, repository, undefined, undefined, { scope, rootPath: root }, memory);
    assert.equal((await agent.runTask(session.sessionId, 'hello', null, () => {}, async () => 'cancel')).status, 'completed');
    assert.equal((await memory.drain()).completed, true);
    assert.equal(extractionCalls, 5);
    assert.equal(events.filter((event) => event.type === 'managed_memory.extraction.failed').length, 1);
    assert.equal((await repository.loadSession(session.sessionId))?.runReports?.at(-1)?.status, 'completed');
  } finally {
    await memory.drain({ timeoutMs: 1_000 });
    await rm(root, { recursive: true, force: true });
    await rm(dirname(repository.sessionsDir), { recursive: true, force: true });
  }
});
