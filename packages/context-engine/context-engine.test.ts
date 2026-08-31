import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelClient, ModelEvent } from '../llm-client/index.ts';
import type { ContextArtifactRef, ContextManifestV2, ContextPolicy, Session } from '../shared/types.ts';
import { createContextEngine, type PutContextArtifact } from './index.ts';

const now = new Date().toISOString();

function structuredSummary() {
  return `## 当前目标
完成上下文机制
## 已完成
已分析历史
## 正在进行
继续测试
## 关键发现与决定
保留完整历史
## 用户约束
不得丢失内容
## 修改过的文件
无
## 失败尝试与原因
无
## 可恢复的工具输出
无
## 下一步
继续执行`;
}

function summaryModel(counter: { calls: number }): ModelClient {
  return {
    model: 'summary-test',
    baseUrl: 'memory://summary',
    reasoning: { supported: false, requestMode: 'disabled' },
    contextWindow: 20_000,
    maxOutputTokens: 1_000,
    async *streamMessage(): AsyncIterable<ModelEvent> {
      counter.calls += 1;
      const content = structuredSummary();
      yield { version: 1, type: 'turn_started', attemptId: `summary-${counter.calls}` };
      yield { version: 1, type: 'text_delta', delta: content };
      yield {
        version: 1,
        type: 'turn_completed',
        response: {
          content,
          reasoning: '',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 500, outputTokens: 120, totalTokens: 620 },
        },
      };
    },
  };
}

function policy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
  return {
    enabled: true,
    contextWindowTokens: 100_000,
    maxOutputTokens: 2_000,
    reserveTokens: 2_000,
    targetRatio: 0.7,
    latestToolResultsToKeep: 2,
    maxConversationMessages: 50,
    latestToolBatchChars: 4_000,
    largeToolResultChars: 2_000,
    ...overrides,
  };
}

function session(): Session {
  return {
    sessionId: 'session-context-test',
    scope: { kind: 'general' },
    createdAt: now,
    updatedAt: now,
    messages: [],
    taskSummaries: [],
    activeTaskId: 'run-context-test',
    contextManifests: [],
    contextSummaries: [],
  };
}

function harness() {
  const state = session();
  const artifacts = new Map<string, string>();
  const started: string[] = [];
  const failed: string[] = [];
  const counter = { calls: 0 };
  const engine = createContextEngine({
    modelClient: summaryModel(counter),
    artifactRepository: {
      async putContextArtifact(input: PutContextArtifact): Promise<ContextArtifactRef> {
        const id = `artifact-${input.kind}-${input.sourceRef}`;
        artifacts.set(id, input.content);
        return { version: 1, id, sessionId: input.sessionId, kind: input.kind, digest: `digest-${input.content.length}`, chars: input.content.length, createdAt: now };
      },
      async readContextArtifact(input) {
        const content = artifacts.get(input.ref);
        if (content === undefined) throw new Error('missing');
        const offset = input.offset ?? 0;
        const end = Math.min(content.length, offset + (input.limit ?? 8_000));
        return { ref: input.ref, content: content.slice(offset, end), offset, ...(end < content.length ? { nextOffset: end } : {}), totalChars: content.length };
      },
    },
    lifecycle: {
      loadSession: async () => state,
      beginContextCompaction: async ({ operationRef }) => { started.push(operationRef); },
      failContextCompaction: async ({ operationRef }) => { failed.push(operationRef); },
      recordContextProviderUsage: async () => {},
    },
  });
  return { engine, state, artifacts, started, failed, counter };
}

function input(messages: Parameters<ReturnType<typeof harness>['engine']['prepare']>[0]['canonicalMessages'], contextPolicy = policy()) {
  return {
    sessionId: 'session-context-test',
    runId: 'run-context-test',
    turn: 1,
    attempt: 1,
    activeRequest: '继续完成任务',
    systemSections: [
      { source: 'systemPrompt' as const, content: 'system rules' },
      { source: 'workspaceCode' as const, content: 'workspace code' },
      { source: 'projectMemory' as const, content: 'project memory' },
    ],
    canonicalMessages: messages,
    toolDefinitions: [{ type: 'function' as const, function: { name: 'read_file', description: 'read' } }],
    policy: contextPolicy,
  };
}

test('prepare builds a fresh full-envelope view without mutating canonical messages', async () => {
  const { engine } = harness();
  const canonical = [{ role: 'user' as const, content: 'hello' }];
  const snapshot = JSON.stringify(canonical);
  const prepared = await engine.prepare(input(canonical));
  assert.equal(JSON.stringify(canonical), snapshot);
  assert.notEqual(prepared.messages, canonical);
  assert.equal(prepared.messages[0]?.role, 'system');
  assert.equal(Object.values(prepared.manifest.breakdown).reduce((sum, value) => sum + value, 0), prepared.usage.usedTokens);
  assert.equal(prepared.manifest.layers.length, 0);
});

test('latest oversized tool output is persisted before the request view is shortened', async () => {
  const { engine, artifacts } = harness();
  const large = 'x'.repeat(8_000);
  const prepared = await engine.prepare(input([
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-large', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-large', name: 'read_file', content: large },
  ]));
  const result = prepared.messages.find((message) => message.role === 'tool');
  assert.equal(result?.role, 'tool');
  if (result?.role === 'tool') assert.match(result.content, /persisted-output/);
  assert.equal([...artifacts.values()][0], large);
  assert.equal(prepared.activity?.externalizedToolResults, 1);
  assert.deepEqual(prepared.manifest.layers, ['large_tool_results']);
});

test('middle history archives whole conversation segments and keeps the first and latest requests', async () => {
  const { engine, artifacts } = harness();
  const messages = Array.from({ length: 6 }, (_, index) => [
    { role: 'user' as const, content: `request-${index}` },
    { role: 'assistant' as const, content: `answer-${index}` },
  ]).flat();
  const prepared = await engine.prepare(input(messages, policy({ maxConversationMessages: 6 })));
  const text = JSON.stringify(prepared.messages);
  assert.match(text, /request-0/);
  assert.match(text, /request-5/);
  assert.match(text, /已归档/);
  assert.equal([...artifacts.values()].some((value) => value.includes('request-2')), true);
  assert.equal(prepared.activity?.archivedConversationSegments! > 0, true);
});

test('old tool results are compacted only after a prior manifest proves they were sent', async () => {
  const { engine, state, artifacts } = harness();
  state.contextManifests?.push({
    version: 2,
    id: 'manifest-seen',
    runId: 'run-context-test',
    turn: 1,
    attempt: 1,
    createdAt: now,
    requestDigest: 'digest',
    requestSerializedChars: 100,
    estimatedInputTokens: 25,
    tokenSource: 'estimated',
    contextWindowTokens: 3_000,
    maxOutputTokens: 300,
    reserveTokens: 200,
    hardLimitTokens: 2_500,
    breakdown: { systemPrompt: 1, workspaceCode: 1, recentConversation: 1, toolResults: 20, projectMemory: 1, managedMemory: 0, toolDefinitions: 1, other: 0 },
    layers: [],
    artifactRefs: [],
    includedToolResultIds: ['call-old'],
  } satisfies ContextManifestV2);
  const prepared = await engine.prepare(input([
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-old', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-old', name: 'read_file', content: 'o'.repeat(6_000) },
    { role: 'user', content: 'current request' },
  ], policy({ contextWindowTokens: 3_000, maxOutputTokens: 300, reserveTokens: 200, targetRatio: 0.3, latestToolResultsToKeep: 0, latestToolBatchChars: 10_000, largeToolResultChars: 9_000 })));
  const result = prepared.messages.find((message) => message.role === 'tool');
  if (result?.role === 'tool') assert.match(result.content, /较早的工具结果已整理/);
  assert.equal(artifacts.size, 1);
  assert.equal(prepared.activity?.compactedToolResults, 1);
});

test('structured summary is cached with a retained tail and reused for later messages', async () => {
  const { engine, state, started, counter } = harness();
  const canonical = Array.from({ length: 5 }, (_, index) => [
    { role: 'user' as const, content: `request-${index} ${'u'.repeat(1_000)}` },
    { role: 'assistant' as const, content: `answer-${index} ${'a'.repeat(1_000)}` },
  ]).flat();
  const contextPolicy = policy({ contextWindowTokens: 3_000, maxOutputTokens: 300, reserveTokens: 200, targetRatio: 0.7, maxConversationMessages: 50 });
  const first = await engine.prepare({ ...input(canonical, contextPolicy), activeRequest: canonical.at(-2)!.content! });
  assert.equal(counter.calls, 1);
  assert.equal(started.length, 1);
  assert.equal(first.summaryRecord?.strategyVersion, 'structured-summary-v2');
  assert.equal(first.activity?.summarizedMessages! > 0, true);
  state.contextSummaries?.push(first.summaryRecord!);
  state.contextManifests?.push(first.manifest);
  const second = await engine.prepare({ ...input([...canonical, { role: 'user', content: 'new request' }], contextPolicy), activeRequest: 'new request', turn: 2, attempt: 2 });
  assert.equal(counter.calls, 1);
  assert.match(JSON.stringify(second.messages), /对话摘要/);
  assert.match(JSON.stringify(second.messages), /new request/);
});
