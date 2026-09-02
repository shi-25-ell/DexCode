import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMockModelClient } from '../llm-client/index.ts';
import { createManagedMemorySystem, truncateIndexForRead } from './index.ts';
import type { AgentRunResult } from '../agent-core/agent-runtime.ts';
import { buildMemoryPolicyPrompt } from './prompt.ts';
import { MEMORY_TOOL_DEFINITIONS } from './tools.ts';
import { validateTopicPath } from './paths.ts';
import type { EnqueueMemoryExtractionInput, InternalMemoryRunInput, MemorySelector } from './contracts.ts';
import { createModelMemorySelector } from './recall.ts';

async function fixture(options: { selector?: MemorySelector; observe?: (event: Record<string, unknown>) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-memory-'));
  const system = createManagedMemorySystem({
    workspaceId: 'workspace-a',
    workspaceStateDir: root,
    modelClient: createMockModelClient(),
    selector: options.selector ?? { select: async () => ['feedback_testing.md'] },
    observe: options.observe,
    clock: () => new Date('2026-08-31T12:00:00.000Z'),
  });
  return { root, system, dispose: async () => { await system.drain({ timeoutMs: 1_000 }); await rm(root, { recursive: true, force: true }); } };
}

async function eventually<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Expected asynchronous memory work to settle');
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function extraction(runId: string, messageIds: string[] = [runId], sessionId = 'session-a'): EnqueueMemoryExtractionInput {
  return {
    workspaceId: 'workspace-a', sessionId, runId, completedAt: new Date().toISOString(), status: 'completed',
    messages: messageIds.map((id) => ({ role: 'assistant', content: id })), messageIds,
    modelClient: createMockModelClient(), systemSections: [{ source: 'systemPrompt', content: 'parent system' }], toolCalls: [],
  };
}

function upsertInput(operationId: string, expectedDigest: string | null = null) {
  return {
    workspaceId: 'workspace-a', actor: 'main-agent' as const, path: 'feedback_testing.md',
    name: '真实数据库测试', description: '集成测试使用真实数据库，并保留历史事故原因', type: 'feedback' as const,
    body: '集成测试必须连接真实数据库。\n\n**Why:** mock 曾掩盖迁移错误。\n\n**How to apply:** 涉及迁移和事务时使用真实适配器。',
    indexTitle: '真实数据库测试', indexHook: '迁移与事务测试使用真实数据库。', expectedDigest, operationId,
  };
}

test('memory_upsert contract makes the bare topic filename rule explicit to the model', () => {
  const definition = MEMORY_TOOL_DEFINITIONS.find((item) => item.function.name === 'memory_upsert');
  assert.ok(definition);
  const pathSchema = definition.function.parameters.properties.path as { description?: string; pattern?: string };
  const titleSchema = definition.function.parameters.properties.indexTitle as { maxLength?: number };
  const hookSchema = definition.function.parameters.properties.indexHook as { maxLength?: number };
  const operationIdSchema = definition.function.parameters.properties.operationId as { description?: string };
  assert.equal(pathSchema.pattern, '^[a-z0-9][a-z0-9_-]{0,79}\\.md$');
  assert.match(pathSchema.description ?? '', /bare filename|裸文件名/i);
  assert.equal(titleSchema.maxLength, 40);
  assert.equal(hookSchema.maxLength, 60);
  assert.match(operationIdSchema.description ?? '', /new unique.*changed|changed.*new unique/i);
  assert.match(buildMemoryPolicyPrompt(true), /bare filename|裸文件名/i);
  assert.throws(
    () => validateTopicPath('topics/coding-agent-project.md'),
    /bare filename.*directory prefixes.*topics\//i,
  );
});

test('replayed rejected operation tells the model to use a new operationId', async () => {
  const value = await fixture();
  try {
    const rejected = await value.system.store.upsert({
      ...upsertInput('op-rejected'),
      indexTitle: 'x'.repeat(201),
    });
    assert.equal(rejected.code, 'MEMORY_REJECTED');

    const replayed = await value.system.store.upsert(upsertInput('op-rejected'));
    assert.equal(replayed.replayed, true);
    assert.match(replayed.error ?? '', /new unique operationId/i);

    const retried = await value.system.store.upsert(upsertInput('op-retry'));
    assert.equal(retried.mutationCommitted, true);
  } finally { await value.dispose(); }
});

test('store atomically upserts topic and index, replays operationId, and detects digest conflicts', async () => {
  const value = await fixture();
  try {
    const created = await value.system.store.upsert(upsertInput('op-create'));
    assert.equal(created.mutationCommitted, true);
    assert.ok(created.digest);
    const topic = await value.system.store.readTopic('workspace-a', 'feedback_testing.md');
    assert.equal(topic.type, 'feedback');
    assert.match((await value.system.store.readIndex('workspace-a'))!.raw, /feedback_testing\.md/);

    const replayed = await value.system.store.upsert(upsertInput('op-create'));
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.digest, created.digest);

    const conflict = await value.system.store.upsert({ ...upsertInput('op-conflict', 'sha256-stale'), body: 'new body' });
    assert.equal(conflict.code, 'MEMORY_CONFLICT');
    assert.equal(conflict.latestDigest, created.digest);
  } finally { await value.dispose(); }
});

test('recall injects policy, bounded index, selected topic and evidence refs', async () => {
  const value = await fixture();
  try {
    await value.system.store.upsert(upsertInput('op-recall'));
    const prepared = await value.system.prepareRun({
      workspaceId: 'workspace-a', sessionId: 'session-b', runId: 'run-b', query: '请新增数据库迁移测试',
    });
    assert.equal(prepared.enabled, true);
    assert.equal(prepared.recall.selectedCount, 0);
    assert.deepEqual(prepared.refs.map((ref) => ref.path), ['MEMORY.md']);
    const ready = await eventually(() => prepared.prefetch?.takeReady());
    assert.equal(ready.recall.selectedCount, 1);
    assert.deepEqual(ready.refs.map((ref) => ref.path), ['feedback_testing.md']);
    assert.match(ready.sections.map((section) => section.content).join('\n'), /mock 曾掩盖迁移错误/);

    const ignored = await value.system.prepareRun({
      workspaceId: 'workspace-a', sessionId: 'session-c', runId: 'run-c', query: '本轮忽略记忆，直接回答',
    });
    assert.equal(ignored.sections.length, 0);
    assert.equal(ignored.refs.length, 0);
  } finally { await value.dispose(); }
});

test('clear preserves settings, increments generation and removes topics', async () => {
  const value = await fixture();
  try {
    await value.system.store.upsert(upsertInput('op-clear'));
    const before = await value.system.updateSettings('workspace-a', { enabled: false });
    const result = await value.system.clearManagedMemory('workspace-a', { confirmationToken: 'CLEAR_MANAGED_MEMORY' });
    assert.ok(result.generation > before.generation);
    assert.equal((await value.system.inspect('workspace-a')).settings.enabled, false);
    assert.equal((await value.system.store.scan('workspace-a')).length, 0);
    assert.equal(await readFile(value.system.store.paths.index, 'utf8'), '# Managed Memory\n');
  } finally { await value.dispose(); }
});

test('index read truncation preserves valid UTF-8 and reports both caps', () => {
  const raw = Array.from({ length: 260 }, (_, index) => `- [主题${index}](topic_${index}.md) — ${'测'.repeat(120)}`).join('\n');
  const truncated = truncateIndexForRead(raw);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.content.includes('\uFFFD'), false);
  assert.match(truncated.content, /Warning:/);
});

function internalResult(messages: AgentRunResult['messages']): AgentRunResult {
  return {
    runId: 'memory-run', profile: 'memory', origin: 'internal', status: 'completed', terminationReason: 'natural_completion',
    finalContent: '', messages, modelTurnCount: 1, modelAttemptCount: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, unknown: 0 }, toolsUsed: ['memory_upsert'], filesModified: [], fileChanges: [], skillsUsed: [],
    contextSummaryUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, contextRefreshWarnings: [], runtimeWarnings: [],
    startedAt: '2026-08-31T12:00:00.000Z', completedAt: '2026-08-31T12:00:01.000Z', durationMs: 1_000,
  };
}

test('completed Main Run enqueues non-blocking extraction and drain persists the memory', async () => {
  const value = await fixture();
  try {
    value.system.setInternalRunner({
      run: async (input) => {
        assert.equal(input.kind, 'extraction');
        const outcome = await value.system.executeTool('memory_upsert', {
          path: 'feedback_testing.md', name: '真实数据库测试', description: '集成测试使用真实数据库', type: 'feedback',
          body: '**Why:** 迁移事故。\n\n**How to apply:** 迁移测试使用真实数据库。', indexTitle: '真实数据库测试', indexHook: '迁移测试使用真实数据库。',
          expectedDigest: null, operationId: 'background-upsert',
        }, { workspaceId: 'workspace-a', actor: 'memory-extractor', generation: input.generation, runId: 'memory-run', sessionId: input.sessionId });
        return internalResult([{ role: 'tool', tool_call_id: 'call-1', name: 'memory_upsert', content: JSON.stringify(outcome) }]);
      },
    });
    const started = Date.now();
    value.system.enqueueExtraction({
      workspaceId: 'workspace-a', sessionId: 'session-a', runId: 'main-run', completedAt: '2026-08-31T12:00:00.000Z', status: 'completed',
      messages: [{ role: 'user', content: '不要 mock 数据库，因为上次迁移事故。' }, { role: 'assistant', content: '明白。' }],
      messageIds: [undefined, 'main-run:message:1'], modelClient: createMockModelClient(),
      systemSections: [], toolCalls: [],
    });
    assert.ok(Date.now() - started < 100);
    const drained = await value.system.drain({ timeoutMs: 5_000 });
    assert.equal(drained.completed, true);
    assert.equal((await value.system.store.scan('workspace-a')).length, 1);
  } finally { await value.dispose(); }
});

test('extraction coalesces busy Sessions, keeps the parent model and prefix, and drains trailing work', async () => {
  const events: Record<string, unknown>[] = [];
  const value = await fixture({ observe: (event) => events.push(event) });
  const gate = deferred();
  const entered = deferred();
  const calls: InternalMemoryRunInput[] = [];
  let concurrent = 0;
  try {
    value.system.setInternalRunner({ run: async (input) => {
      concurrent += 1;
      assert.equal(concurrent, 1);
      calls.push(input);
      if (calls.length === 1) { entered.resolve(); await gate.promise; }
      concurrent -= 1;
      return internalResult([]);
    } });
    const first = extraction('r1');
    value.system.enqueueExtraction(first);
    await entered.promise;
    value.system.enqueueExtraction(extraction('r2', ['r1', 'r2']));
    value.system.enqueueExtraction(extraction('r3', ['r1', 'r2', 'r3']));
    value.system.enqueueExtraction(extraction('b1', ['b1'], 'session-b'));
    assert.equal(calls.length, 1);
    gate.resolve();
    assert.equal((await value.system.drain()).completed, true);
    assert.deepEqual(calls.map((call) => call.parentRunId), ['r1', 'r3', 'b1']);
    assert.equal(calls[0]!.modelClient, first.modelClient);
    assert.deepEqual(calls[0]!.systemSections, first.systemSections);
    assert.deepEqual(calls[1]!.messages.slice(0, -1), extraction('r3', ['r1', 'r2', 'r3']).messages);
    assert.equal(calls[0]!.messages.at(-1)?.role, 'user');
    assert.deepEqual(events.filter((event) => event.type === 'managed_memory.extraction.started').map((event) => event.newMessageCount), [1, 2, 1]);
    await assert.rejects(readFile(value.system.store.paths.checkpoints), { code: 'ENOENT' });
  } finally { gate.resolve(); await value.dispose(); }
});

test('extraction throttle is effective and trailing work bypasses it; committed main writes skip extraction', async () => {
  const events: Record<string, unknown>[] = [];
  const value = await fixture({ observe: (event) => events.push(event) });
  const gate = deferred();
  const entered = deferred();
  const calls: string[] = [];
  const idle = () => eventually(async () => !(await value.system.inspect('workspace-a')).background.inProgress ? true : undefined);
  try {
    await value.system.updateSettings('workspace-a', { extractionEveryCompletedRuns: 2 });
    value.system.setInternalRunner({ run: async (input) => {
      calls.push(input.parentRunId!);
      if (calls.length === 1) { entered.resolve(); await gate.promise; }
      return internalResult([]);
    } });
    value.system.enqueueExtraction(extraction('r1'));
    await idle();
    assert.equal(calls.length, 0);
    value.system.enqueueExtraction(extraction('r2', ['r1', 'r2']));
    await entered.promise;
    value.system.enqueueExtraction(extraction('r3', ['r1', 'r2', 'r3']));
    gate.resolve();
    await idle();
    const direct = extraction('r4', ['r1', 'r2', 'r3', 'r4']);
    direct.toolCalls = [{ name: 'memory_upsert', input: {}, outcome: { mutationCommitted: true } }];
    value.system.enqueueExtraction(direct);
    await idle();
    value.system.enqueueExtraction(extraction('r5', ['r4', 'r5']));
    await idle();
    value.system.enqueueExtraction(extraction('r6', ['r4', 'r5', 'r6']));
    await idle();
    assert.deepEqual(calls, ['r2', 'r3', 'r6']);
    assert.deepEqual(events.filter((event) => event.type === 'managed_memory.extraction.started').map((event) => event.newMessageCount), [2, 1, 2]);
  } finally { gate.resolve(); await value.dispose(); }
});

test('unresolved mutations retain the ID cursor, successful retries resolve only the same target and operation', async () => {
  const events: Record<string, unknown>[] = [];
  const value = await fixture({ observe: (event) => events.push(event) });
  const outcome = (path: string, committed: boolean, name = 'memory_upsert'): AgentRunResult['messages'][number] => ({
    role: 'tool', name, tool_call_id: crypto.randomUUID(), content: JSON.stringify({ path, mutationCommitted: committed, ...(committed ? {} : { code: 'MEMORY_CONFLICT' }) }),
  });
  const recovered: AgentRunResult['messages'] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'bad-digest', type: 'function', function: { name: 'memory_upsert', arguments: JSON.stringify({ path: 'a.md', expectedDigest: 'null' }) } }] },
    { role: 'tool', name: 'memory_upsert', tool_call_id: 'bad-digest', content: JSON.stringify({ error: 'digest must be null', code: 'MEMORY_REJECTED' }) },
    outcome('a.md', true),
  ];
  const results = [[], [outcome('a.md', false), outcome('b.md', true)], [outcome('a.md', false), outcome('a.md', true, 'memory_remove')], recovered, [], []];
  try {
    value.system.setInternalRunner({ run: async () => internalResult(results.shift()!) });
    for (const input of [extraction('r1'), extraction('r2', ['r1', 'r2']), extraction('r3', ['r1', 'r2', 'r3']), extraction('r4', ['r1', 'r2', 'r3', 'r4']), extraction('r5', ['r4', 'r5']), extraction('r6', ['summary', 'r6'])]) {
      value.system.enqueueExtraction(input);
      await eventually(async () => !(await value.system.inspect('workspace-a')).background.inProgress ? true : undefined);
    }
    assert.deepEqual(events.filter((event) => event.type === 'managed_memory.extraction.started').map((event) => event.newMessageCount), [1, 1, 2, 3, 1, 2]);
    assert.equal(events.filter((event) => event.type === 'managed_memory.extraction.failed').length, 2);
    assert.equal((await value.system.inspect('workspace-a')).background.lastError, undefined);
  } finally { await value.dispose(); }
});

test('recall never waits for selection, filters surfaced candidates, and disposes cancelled or disabled work', async () => {
  const selections: Array<{ signal?: AbortSignal; gate: ReturnType<typeof deferred<string[]>> }> = [];
  const value = await fixture({ selector: { select(input) {
    const gate = deferred<string[]>(); selections.push({ signal: input.signal, gate }); return gate.promise;
  } } });
  const prepare = (runId: string, sessionId = 'session-a') => value.system.prepareRun({ workspaceId: 'workspace-a', sessionId, runId, query: '数据库迁移测试' });
  try {
    await value.system.store.upsert(upsertInput('recall-prefetch'));
    const first = await prepare('r1');
    assert.equal(selections.length, 1);
    assert.equal(first.prefetch?.takeReady(), undefined);
    await prepare('r1');
    assert.equal(selections.length, 1);
    selections[0]!.gate.resolve(['feedback_testing.md']);
    await eventually(() => first.prefetch?.takeReady());
    const second = await prepare('r2');
    assert.equal(second.recall.candidateCount, 0);
    assert.equal(selections.length, 1);
    const cancelled = await prepare('r3', 'session-b');
    cancelled.prefetch?.dispose();
    assert.equal(selections[1]!.signal?.aborted, true);
    selections[1]!.gate.resolve(['feedback_testing.md']);
    assert.equal(cancelled.prefetch?.takeReady(), undefined);
    const disabled = await prepare('r4', 'session-b');
    await value.system.updateSettings('workspace-a', { recallEnabled: false });
    assert.equal(selections[2]!.signal?.aborted, true);
    selections[2]!.gate.resolve(['feedback_testing.md']);
    assert.equal(disabled.prefetch?.takeReady(), undefined);
  } finally { selections.forEach((item) => item.gate.resolve([])); await value.dispose(); }
});

test('model selector makes no provider request when all candidates are already surfaced', async () => {
  let calls = 0;
  const client = { ...createMockModelClient(), async *streamMessage() { calls += 1; throw new Error('unexpected request'); } };
  const candidate = { path: 'a.md', digest: 'digest', name: 'a', description: 'a', type: 'user' as const, mtimeMs: 0, bytes: 1 };
  assert.deepEqual(await createModelMemorySelector(client).select({ query: 'a', candidates: [candidate], alreadySurfaced: new Set(['a.md:digest']) }), []);
  assert.equal(calls, 0);
});

test('global background limit reserves two slots and drain cancels queued work without starting it later', async () => {
  const values = await Promise.all([fixture(), fixture(), fixture()]);
  const gate = deferred();
  let entered = 0;
  try {
    for (const value of values) value.system.setInternalRunner({ run: async () => { entered += 1; await gate.promise; return internalResult([]); } });
    values[0]!.system.enqueueExtraction(extraction('first'));
    values[1]!.system.enqueueExtraction(extraction('second'));
    await eventually(() => entered === 2 ? true : undefined);
    values[2]!.system.enqueueExtraction(extraction('third'));
    await eventually(async () => (await values[2]!.system.inspect('workspace-a')).background.inProgress ? true : undefined);
    const cancelled = await values[2]!.system.drain({ timeoutMs: 0 });
    assert.equal(cancelled.completed, false);
    assert.equal(cancelled.aborted, 1);
    gate.resolve();
    await Promise.all(values.map((value) => value.system.drain({ timeoutMs: 1_000 })));
    assert.equal(entered, 2);
  } finally { gate.resolve(); await Promise.all(values.map((value) => value.dispose())); }
});
