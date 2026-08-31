import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutor } from './executor.ts';
import type { ModelClient, ModelEvent, ModelResponse } from '../llm-client/index.ts';
import type { ContextEngine, PrepareContextInput, PreparedContext } from '../context-engine/index.ts';
import type { AgentEvent } from '../shared/types.ts';

function scriptedModel(responses: ModelResponse[]): ModelClient {
  let index = 0;
  return {
    model: 'scripted',
    baseUrl: 'scripted://local',
    async *streamMessage(): AsyncIterable<ModelEvent> {
      const response = responses[index++];
      if (!response) throw new Error('unexpected model call');
      yield { version: 1, type: 'turn_started', attemptId: `attempt-${index}` };
      if (response.content) yield { version: 1, type: 'text_delta', delta: response.content };
      for (const [toolIndex, call] of response.toolCalls.entries()) {
        yield {
          version: 1,
          type: 'tool_call_delta',
          index: toolIndex,
          id: call.id,
          name: call.name,
          argumentsDelta: JSON.stringify(call.arguments),
        };
      }
      yield { version: 1, type: 'turn_completed', response };
    },
  };
}

function toolHost(timeline: string[] = []) {
  let content = 'before';
  return {
    host: {
      readFile: (path: string) => ({ path, content }),
      writeFile: (_path: string, next: string) => { timeline.push('effect'); content = next; return { ok: true }; },
      runCommand: () => null,
      listWorkspace: () => [],
      searchInWorkspace: () => [],
      patchFile: () => null,
      listVersions: () => [],
      createSnapshot: () => null,
      restoreSnapshot: () => null,
    },
    read: () => content,
  };
}

function prepared(input: PrepareContextInput): PreparedContext {
  const breakdown = { systemPrompt: 2, workspaceCode: 0, recentConversation: 3, toolResults: 0, projectMemory: 0, toolDefinitions: 1, other: 1 };
  return {
    messages: [{ role: 'system', content: 'system' }, ...input.canonicalMessages],
    manifest: {
      version: 2,
      id: `manifest-${input.turn}-${input.attempt}`,
      runId: input.runId,
      turn: input.turn,
      attempt: input.attempt,
      createdAt: new Date().toISOString(),
      requestDigest: `digest-${input.turn}-${input.attempt}`,
      requestSerializedChars: 28,
      estimatedInputTokens: 7,
      tokenSource: 'estimated',
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
      reserveTokens: 500,
      hardLimitTokens: 8_500,
      breakdown,
      layers: [],
      artifactRefs: [],
      includedToolResultIds: input.canonicalMessages.flatMap((message) => message.role === 'tool' ? [message.tool_call_id] : []),
    },
    usage: { usedTokens: 7, contextWindowTokens: 10_000, hardLimitTokens: 8_500, percentage: 0.1, source: 'estimated', timing: 'next_request', asOfTurn: input.turn, asOfAttempt: input.attempt, breakdown, breakdownEstimated: true },
  };
}

function contextRuntime(engine: ContextEngine) {
  return {
    engine,
    sessionId: 'session-executor',
    activeRequest: 'run it',
    systemSections: [{ source: 'systemPrompt' as const, content: 'system' }],
    policy: {
      enabled: true,
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
      reserveTokens: 500,
      targetRatio: 0.7,
      latestToolResultsToKeep: 2,
      maxConversationMessages: 50,
      latestToolBatchChars: 4_000,
      largeToolResultChars: 2_000,
    },
    readArtifact: async () => ({ content: '' }),
  };
}

test('streams text deltas and completes a no-tool Run', async () => {
  const { host } = toolHost();
  const events: unknown[] = [];
  const result = await createExecutor(host).runReActLoop(scriptedModel([{
    content: 'done',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
  }]), [], (event) => events.push(event));

  assert.equal(result.status, 'completed');
  assert.equal(result.finalContent, 'done');
  assert.deepEqual(events.find((event) => (event as { type?: string }).type === 'chunk'), { type: 'chunk', chunk: 'done' });
});

test('consumes one Steer at a natural safe boundary before the next model request', async () => {
  const { host } = toolHost();
  const scripted = scriptedModel([
    { content: 'first answer', reasoning: '', toolCalls: [], finishReason: 'stop' },
    { content: 'steered answer', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  const requests: string[][] = [];
  const model: ModelClient = {
    ...scripted,
    async *streamMessage(messages, options) {
      requests.push(messages.flatMap((message) => message.role === 'user' ? [message.content] : []));
      yield* scripted.streamMessage(messages, options);
    },
  };
  let boundaries = 0;
  const result = await createExecutor(host).runReActLoop(model, [{ role: 'user', content: 'initial' }], () => {}, undefined, {
    runId: 'run-steer',
    sessionId: 'session-steer',
    commandSource: {
      async atSafeBoundary() {
        boundaries += 1;
        return boundaries === 1
          ? { action: 'continue', steer: { role: 'user', content: 'change direction' }, itemId: 'queue-1', directive: 'change direction' }
          : { action: 'finish' };
      },
    },
    refreshDirective: async () => ({ systemSections: [{ source: 'systemPrompt', content: 'refreshed system' }] }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.modelTurnCount, 2);
  assert.deepEqual(requests[1], ['initial', 'change direction']);
});

test('waits for an entire tool batch before applying Steer', async () => {
  const timeline: string[] = [];
  const { host } = toolHost(timeline);
  const model = scriptedModel([
    {
      content: '',
      reasoning: '',
      toolCalls: [
        { id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } },
        { id: 'call-2', name: 'read_file', arguments: { path: 'b.ts' } },
      ],
      finishReason: 'tool_calls',
    },
    { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  let boundaries = 0;
  await createExecutor(host).runReActLoop(model, [{ role: 'user', content: 'initial' }], () => {}, undefined, {
    commandSource: {
      async atSafeBoundary() {
        timeline.push('safe-boundary');
        boundaries += 1;
        return boundaries === 1
          ? { action: 'continue', steer: { role: 'user', content: 'steer' }, itemId: 'queue-1', directive: 'steer' }
          : { action: 'finish' };
      },
    },
    semantic: {
      assistantCommitted: async () => { timeline.push('assistant'); },
      toolStarted: async (call) => { timeline.push(`started-${call.id}`); },
      toolOutcome: async (message) => { timeline.push(`outcome-${message.tool_call_id}`); },
    },
  });
  assert.deepEqual(timeline.slice(0, 6), ['assistant', 'started-call-1', 'outcome-call-1', 'started-call-2', 'outcome-call-2', 'safe-boundary']);
});

test('does not consume Steer after the model turn budget is exhausted', async () => {
  const { host } = toolHost();
  let consumed = false;
  const result = await createExecutor(host).runReActLoop(scriptedModel([{
    content: '',
    reasoning: '',
    toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
    finishReason: 'tool_calls',
  }]), [], () => {}, undefined, {
    maxIterations: 1,
    commandSource: {
      async atSafeBoundary(input) {
        assert.equal(input.remainingModelTurns, 0);
        consumed = false;
        return { action: 'proceed' };
      },
    },
  });
  assert.equal(result.status, 'limited');
  assert.equal(consumed, false);
});

test('commits assistant and tool start before effect, then commits outcome', async () => {
  const timeline: string[] = [];
  const { host, read } = toolHost(timeline);
  const model = scriptedModel([
    {
      content: '',
      reasoning: '',
      toolCalls: [{ id: 'call-1', name: 'write_file', arguments: { path: 'a.ts', content: 'after' } }],
      finishReason: 'tool_calls',
    },
    { content: 'finished', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  const result = await createExecutor(host).runReActLoop(model, [], () => {}, undefined, {
    semantic: {
      assistantCommitted: async () => { timeline.push('assistant'); },
      toolStarted: async () => { timeline.push('tool_started'); },
      toolOutcome: async () => { timeline.push('tool_outcome'); },
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.finalContent, 'finished');
  assert.equal(read(), 'after');
  assert.deepEqual(timeline.slice(0, 4), ['assistant', 'tool_started', 'effect', 'tool_outcome']);
  assert.deepEqual(result.fileChanges, [{ path: 'a.ts', before: 'before', after: 'after' }]);
});

test('returns limited rather than completed when the model turn budget is exhausted', async () => {
  const { host } = toolHost();
  const model = scriptedModel([{
    content: '',
    reasoning: '',
    toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
    finishReason: 'tool_calls',
  }]);
  const result = await createExecutor(host).runReActLoop(model, [], () => {}, undefined, { maxIterations: 1 });
  assert.equal(result.status, 'limited');
  assert.equal(result.terminationReason, 'model_turn_limit');
});

test('prepares and durably commits every model request in a multi-turn Run', async () => {
  const timeline: string[] = [];
  const { host } = toolHost(timeline);
  const prepareInputs: PrepareContextInput[] = [];
  const engine: ContextEngine = {
    async prepare(input) { prepareInputs.push(input); timeline.push(`prepare-${input.turn}`); return prepared(input); },
    async recoverFromOverflow(input) { return prepared({ ...input, forceSummary: true }); },
    async recordProviderUsage() {},
  };
  const responses: ModelResponse[] = [
    { content: '', reasoning: '', toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'a.ts' } }], finishReason: 'tool_calls' },
    { content: '', reasoning: '', toolCalls: [{ id: 'read-2', name: 'read_file', arguments: { path: 'a.ts' } }], finishReason: 'tool_calls' },
    { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ];
  let modelCalls = 0;
  const model = scriptedModel(responses);
  const observed: ModelClient = { ...model, async *streamMessage(messages, options) {
    modelCalls += 1;
    assert.equal(timeline.at(-1), `commit-${modelCalls}`);
    yield* model.streamMessage(messages, options);
  } };
  const result = await createExecutor(host).runReActLoop(observed, [{ role: 'user', content: 'run it' }], () => {}, undefined, {
    context: contextRuntime(engine),
    semantic: {
      assistantCommitted: async () => {},
      toolStarted: async () => {},
      toolOutcome: async () => {},
      contextPrepared: async (value) => { timeline.push(`commit-${value.manifest.turn}`); },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(modelCalls, 3);
  assert.equal(prepareInputs.length, 3);
  assert.equal(prepareInputs[1]?.canonicalMessages.some((message) => message.role === 'tool' && message.tool_call_id === 'read-1'), true);
});

test('context overflow performs one recovery retry without repeating completed tool effects', async () => {
  const timeline: string[] = [];
  const { host } = toolHost(timeline);
  let prepares = 0;
  let recoveries = 0;
  const engine: ContextEngine = {
    async prepare(input) { prepares += 1; return prepared(input); },
    async recoverFromOverflow(input) { recoveries += 1; return prepared({ ...input, forceSummary: true }); },
    async recordProviderUsage() {},
  };
  const script: Array<ModelResponse | 'overflow'> = [
    { content: '', reasoning: '', toolCalls: [{ id: 'write-once', name: 'write_file', arguments: { path: 'a.ts', content: 'after' } }], finishReason: 'tool_calls' },
    'overflow',
    { content: 'recovered', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ];
  let index = 0;
  const model: ModelClient = {
    model: 'overflow-test',
    baseUrl: 'memory://overflow',
    async *streamMessage(): AsyncIterable<ModelEvent> {
      const item = script[index++];
      yield { version: 1, type: 'turn_started', attemptId: `attempt-${index}` };
      if (item === 'overflow') {
        yield { version: 1, type: 'turn_failed', failure: { category: 'context_overflow', retryable: false, message: 'too long' } };
        return;
      }
      if (!item) throw new Error('unexpected model call');
      if (item.content) yield { version: 1, type: 'text_delta', delta: item.content };
      for (const [toolIndex, call] of item.toolCalls.entries()) {
        yield { version: 1, type: 'tool_call_delta', index: toolIndex, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) };
      }
      yield { version: 1, type: 'turn_completed', response: item };
    },
  };
  const result = await createExecutor(host).runReActLoop(model, [{ role: 'user', content: 'write once' }], () => {}, undefined, {
    context: contextRuntime(engine),
    semantic: {
      assistantCommitted: async () => {},
      toolStarted: async () => {},
      toolOutcome: async () => {},
      contextPrepared: async () => {},
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.finalContent, 'recovered');
  assert.equal(timeline.filter((value) => value === 'effect').length, 1);
  assert.equal(recoveries, 1);
  assert.equal(prepares, 2);
  assert.equal(result.modelAttemptCount, 3);
});

test('active compaction waits for the full tool batch and is not shown as a normal Tool Card', async () => {
  const timeline: string[] = [];
  const events: AgentEvent[] = [];
  const { host } = toolHost(timeline);
  const forceFlags: Array<boolean | undefined> = [];
  const engine: ContextEngine = {
    async prepare(input) { forceFlags.push(input.forceSummary); timeline.push(`prepare-${input.turn}`); return prepared(input); },
    async recoverFromOverflow(input) { return prepared({ ...input, forceSummary: true }); },
    async recordProviderUsage() {},
  };
  const model = scriptedModel([
    {
      content: '',
      reasoning: '',
      toolCalls: [
        { id: 'compact-hidden', name: 'compact_context', arguments: {} },
        { id: 'write-after-compact', name: 'write_file', arguments: { path: 'a.ts', content: 'after' } },
      ],
      finishReason: 'tool_calls',
    },
    { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  const result = await createExecutor(host).runReActLoop(model, [{ role: 'user', content: 'compact then write' }], (event) => events.push(event), undefined, {
    context: contextRuntime(engine),
    semantic: {
      assistantCommitted: async () => {},
      toolStarted: async (call) => { timeline.push(`started-${call.id}`); },
      toolOutcome: async (message) => { timeline.push(`outcome-${message.tool_call_id}`); },
      contextPrepared: async () => {},
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(forceFlags, [false, true]);
  assert.equal(timeline.indexOf('outcome-write-after-compact') < timeline.indexOf('prepare-2'), true);
  assert.equal(events.some((event) => event.type === 'tool_view' && event.presentation.callRef === 'compact-hidden'), false);
});

test('sequential tools in one model turn authorize against live state independently', async () => {
  const item = toolHost();
  let mode = 'read_only';
  const observedModes: string[] = [];
  const host = {
    ...item.host,
    executeAgentTool: async (name: string, args: Record<string, unknown>) => {
      observedModes.push(mode);
      if (observedModes.length === 1) mode = 'full_access';
      if (name === 'write_file') return item.host.writeFile(String(args.path), String(args.content));
      return { ok: true };
    },
  };
  const model = scriptedModel([
    {
      content: '',
      reasoning: '',
      toolCalls: [
        { id: 'write-1', name: 'write_file', arguments: { path: 'a.ts', content: 'first' } },
        { id: 'write-2', name: 'write_file', arguments: { path: 'a.ts', content: 'second' } },
      ],
      finishReason: 'tool_calls',
    },
    { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  const result = await createExecutor(host).runReActLoop(model, [], () => {});
  assert.equal(result.status, 'completed');
  assert.deepEqual(observedModes, ['read_only', 'full_access']);
  assert.equal(item.read(), 'second');
});
