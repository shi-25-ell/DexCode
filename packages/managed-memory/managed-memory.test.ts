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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-memory-'));
  const system = createManagedMemorySystem({
    workspaceId: 'workspace-a',
    workspaceStateDir: root,
    modelClient: createMockModelClient(),
    selector: { select: async () => ['feedback_testing.md'] },
    clock: () => new Date('2026-08-31T12:00:00.000Z'),
  });
  return { root, system, dispose: () => rm(root, { recursive: true, force: true }) };
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
  assert.equal(pathSchema.pattern, '^[a-z0-9][a-z0-9_-]{0,79}\\.md$');
  assert.match(pathSchema.description ?? '', /bare filename|裸文件名/i);
  assert.match(buildMemoryPolicyPrompt(true), /bare filename|裸文件名/i);
  assert.throws(
    () => validateTopicPath('topics/coding-agent-project.md'),
    /bare filename.*directory prefixes.*topics\//i,
  );
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
    assert.equal(prepared.recall.selectedCount, 1);
    assert.deepEqual(prepared.refs.map((ref) => ref.path), ['MEMORY.md', 'feedback_testing.md']);
    assert.match(prepared.sections.map((section) => section.content).join('\n'), /mock 曾掩盖迁移错误/);

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
      systemSections: [], toolCalls: [],
    });
    assert.ok(Date.now() - started < 100);
    const drained = await value.system.drain({ timeoutMs: 5_000 });
    assert.equal(drained.completed, true);
    assert.equal((await value.system.store.scan('workspace-a')).length, 1);
  } finally { await value.dispose(); }
});
