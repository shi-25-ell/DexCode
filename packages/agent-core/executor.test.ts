import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutor } from './executor.ts';
import type { ModelClient, ModelEvent, ModelResponse } from '../llm-client/index.ts';
import type { ContextEngine, PrepareContextInput, PreparedContext } from '../context-engine/index.ts';
import type { AgentEvent, ChatMessage } from '../shared/types.ts';
import type { RunEventPayload } from '../run-protocol/index.ts';

function scriptedModel(responses: ModelResponse[]): ModelClient {
  let index = 0;
  return {
    model: 'scripted',
    baseUrl: 'scripted://local',
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
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

function modelRejectingInvalidAssistantHistory(content = 'continued'): ModelClient {
  return {
    model: 'reject-invalid-history',
    baseUrl: 'memory://reject-invalid-history',
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
    async *streamMessage(messages): AsyncIterable<ModelEvent> {
      yield { version: 1, type: 'turn_started', attemptId: 'attempt-next-run' };
      const hasInvalidAssistant = (messages as ChatMessage[]).some((message) => (
        message.role === 'assistant'
        && message.content === null
        && (message.tool_calls?.length ?? 0) === 0
      ));
      if (hasInvalidAssistant) {
        yield {
          version: 1,
          type: 'turn_failed',
          failure: {
            category: 'invalid_request',
            retryable: false,
            httpStatus: 400,
            message: 'LLM request failed: 400 Bad Request',
          },
        };
        return;
      }
      yield { version: 1, type: 'text_delta', delta: content };
      yield {
        version: 1,
        type: 'turn_completed',
        response: { content, reasoning: '', toolCalls: [], finishReason: 'stop' },
      };
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
      find: () => ({ paths: [] }),
      ls: () => ({ entries: [] }),
      grep: () => ({ match_count: 0, output: '' }),
      patchFile: () => null,
    },
    read: () => content,
  };
}

function prepared(input: PrepareContextInput): PreparedContext {
  const breakdown = { systemPrompt: 2, workspaceCode: 0, recentConversation: 3, toolResults: 0, projectKnowledge: 0, managedMemory: 0, toolDefinitions: 1, other: 1 };
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

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function preparedWithActivity(input: PrepareContextInput, summarized: boolean): PreparedContext {
  const base = prepared(input);
  const activity: NonNullable<PreparedContext['activity']> = {
    operationRef: `context-${input.turn}-${input.attempt}`,
    layers: [summarized ? 'summary' : 'middle_archive'],
    beforeTokens: 12,
    afterTokens: 7,
    beforeBreakdown: base.manifest.breakdown,
    afterBreakdown: base.manifest.breakdown,
    externalizedToolResults: 0,
    archivedMessages: summarized ? 0 : 4,
    archivedConversationSegments: summarized ? 0 : 2,
    compactedToolResults: 0,
    summarizedMessages: summarized ? 4 : 0,
    retainedConversationSegments: summarized ? 1 : 0,
    retainedMessageCount: summarized ? 2 : 0,
  };
  const summaryRecord: NonNullable<PreparedContext['summaryRecord']> = {
    version: 2,
    id: `summary-${input.turn}-${input.attempt}`,
    runId: input.runId,
    turn: input.turn,
    strategyVersion: 'structured-summary-v2',
    sourceDigest: 'source-digest',
    coveredMessageCount: 4,
    summary: 'summary',
    retainedTail: [],
    retainedTailDigest: 'tail-digest',
    tokensBefore: 12,
    tokensAfter: 7,
    summaryModel: 'test-model',
    createdAt: new Date().toISOString(),
    artifactRefs: [],
  };
  return {
    ...base,
    manifest: {
      ...base.manifest,
      layers: activity.layers,
      activity,
      ...(summarized ? { summaryRecordId: summaryRecord.id } : {}),
    },
    activity,
    ...(summarized ? { summaryRecord } : {}),
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

test('read_artifact remains internal and emits no frontend tool lifecycle', async () => {
  const { host } = toolHost();
  const runEvents: RunEventPayload[] = [];
  let reads = 0;
  const engine: ContextEngine = {
    async prepare(input) { return prepared(input); },
    async recoverFromOverflow(input) { return prepared({ ...input, forceSummary: true }); },
    async recordProviderUsage() {},
  };
  const context = {
    ...contextRuntime(engine),
    readArtifact: async () => { reads += 1; return { content: 'artifact body' }; },
  };
  const result = await createExecutor(host).runReActLoop(scriptedModel([{
    content: '', reasoning: '',
    toolCalls: [{ id: 'artifact-call', name: 'read_artifact', arguments: { ref: 'artifact-ref' } }],
    finishReason: 'tool_calls',
  }, {
    content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop',
  }]), [{ role: 'user', content: 'read it' }], () => {}, undefined, {
    context,
    presentation: { emit: (event) => runEvents.push(event) },
  });
  assert.equal(result.status, 'completed');
  assert.equal(reads, 1);
  assert.equal(runEvents.some((event) => (
    (event.type === 'tool_started' || event.type === 'tool_progress' || event.type === 'tool_finished')
    && event.callId === 'artifact-call'
  )), false);
});

test('orchestration tools receive immutable caller context and stay out of ordinary Tool Cards', async () => {
  const { host } = toolHost();
  const events: AgentEvent[] = [];
  const calls: unknown[] = [];
  const requestedTools: unknown[][] = [];
  const orchestration = {
    definitions: () => [
      { name: 'general-writer', description: 'General writable agent.', filePermission: 'write_files' as const },
      { name: 'general-reader', description: 'General read-only agent.', filePermission: 'read_only' as const },
    ],
    spawn: async (input: unknown, caller: unknown) => { calls.push({ input, caller }); return { agent_id: 'agent-a', status: 'running' }; },
    wait: async (input: unknown, caller: unknown) => { calls.push({ input, caller }); return { completed: [] }; },
    followup: async () => ({}), stop: async () => ({}),
  };
  const scripted = scriptedModel([
    { content: '', reasoning: '', toolCalls: [{ id: 'spawn-1', name: 'spawn_agent', arguments: { task: 'inspect', context_mode: 'fork' } }], finishReason: 'tool_calls' },
    { content: '', reasoning: '', toolCalls: [{ id: 'wait-1', name: 'wait_agent', arguments: { agent_ids: ['agent-a'], mode: 'all', timeout_ms: 30_000 } }], finishReason: 'tool_calls' },
    { content: 'delegated', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  const model: ModelClient = {
    ...scripted,
    streamMessage(messages, options) {
      requestedTools.push((options?.tools ?? []) as unknown[]);
      return scripted.streamMessage(messages, options);
    },
  };
  const result = await createExecutor(host, undefined, undefined, orchestration).runReActLoop(model, [{ role: 'user', content: 'delegate this' }], (event) => events.push(event), undefined, { runId: 'main-1', sessionId: 'session-1' });
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[0] as { input: unknown }).input, { task: 'inspect', contextMode: 'fork' });
  assert.equal((calls[0] as { caller: { forkSnapshot: ChatMessage[] } }).caller.forkSnapshot.at(-1)?.role, 'user');
  assert.deepEqual((calls[1] as { input: unknown }).input, { agentIds: ['agent-a'], mode: 'all', timeoutMs: 30_000 });
  assert.equal(events.some((event) => event.type === 'tool' || event.type === 'tool_view' || event.type === 'tool_status'), false);
  const spawn = requestedTools[0]?.find((tool) => (tool as { function?: { name?: string } }).function?.name === 'spawn_agent') as { function: { description?: string; parameters: { required: string[]; properties: { agent: { enum?: string[]; default?: string; description?: string }; context_mode: { description?: string } } } } };
  assert.deepEqual(spawn.function.parameters.required, ['task']);
  assert.deepEqual(spawn.function.parameters.properties.agent.enum, ['general-writer', 'general-reader']);
  assert.equal(spawn.function.parameters.properties.agent.default, 'general-reader');
  assert.match(spawn.function.parameters.properties.agent.description ?? '', /general-writer \[write_files\].*general-reader \[read_only\]/);
  assert.match(spawn.function.parameters.properties.agent.description ?? '', /Omit to use general-reader/);
  assert.match(spawn.function.description ?? '', /At most one shared-workspace write_files agent.*read_only agents may run in parallel/i);
  assert.match(spawn.function.description ?? '', /fresh.*self-contained.*fork.*bounded snapshot.*continue independently/i);
  assert.match(spawn.function.description ?? '', /block=true.*foreground.*background delivery/i);
  assert.match(spawn.function.parameters.properties.context_mode.description ?? '', /fresh.*without the main conversation.*fork.*current context.*definition's default/i);
  const wait = requestedTools[0]?.find((tool) => (tool as { function?: { name?: string } }).function?.name === 'wait_agent') as { function: { description?: string } };
  assert.match(wait.function.description ?? '', /foreground.*Steer.*only the wait is cancelled.*Child Runs remain active/i);
});

test('foreground wait_agent yields promptly to Steer without cancelling Main or Child', async () => {
  const { host } = toolHost();
  const waitEntered = deferred();
  const steerArrived = deferred();
  let waitCancelled = false;
  const orchestration = {
    spawn: async () => ({}),
    wait: async (_input: unknown, caller: { signal?: AbortSignal }) => {
      waitEntered.release();
      await Promise.race([
        new Promise<void>((resolve) => caller.signal?.addEventListener('abort', () => { waitCancelled = true; resolve(); }, { once: true })),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
      return { status: 'running', cancelled: waitCancelled, running: [{ agent_id: 'agent-a' }] };
    },
    followup: async () => ({}),
    stop: async () => ({}),
  };
  let boundaries = 0;
  const commandSource = {
    async waitForSteer() { await steerArrived.promise; return 'steer' as const; },
    async atSafeBoundary() {
      boundaries += 1;
      return boundaries === 1
        ? { action: 'continue' as const, steer: { role: 'user' as const, content: 'answer now' }, itemId: 'steer-1', directive: 'answer now' }
        : { action: 'finish' as const };
    },
  };
  const model = scriptedModel([
    { content: '', reasoning: '', toolCalls: [{ id: 'wait-foreground', name: 'wait_agent', arguments: { agent_ids: ['agent-a'], mode: 'all', block: true, timeout_ms: 60_000 } }], finishReason: 'tool_calls' },
    { content: 'answered during wait', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  const startedAt = Date.now();
  const running = createExecutor(host, undefined, undefined, orchestration).runReActLoop(
    model,
    [{ role: 'user', content: 'delegate' }],
    () => {},
    undefined,
    { runId: 'run-foreground-wait', sessionId: 'session-foreground-wait', commandSource },
  );
  await waitEntered.promise;
  steerArrived.release();
  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(result.finalContent, 'answered during wait');
  assert.equal(waitCancelled, true);
  assert.ok(Date.now() - startedAt < 200, 'Steer should interrupt the foreground wait instead of waiting for its timeout');
});

test('an orchestration circuit result terminates the Run without another model turn', async () => {
  const { host } = toolHost();
  const model = scriptedModel([
    { content: '', reasoning: '', toolCalls: [{ id: 'wait-circuit', name: 'wait_agent', arguments: { agent_ids: ['agent-a'] } }], finishReason: 'tool_calls' },
  ]);
  const orchestration = {
    spawn: async () => ({}),
    wait: async () => ({ status: 'circuit_open', code: 'orchestration_stalled', orchestration_circuit_open: true }),
    followup: async () => ({}),
    stop: async () => ({}),
  };
  const result = await createExecutor(host, undefined, undefined, orchestration).runReActLoop(
    model,
    [{ role: 'user', content: 'wait' }],
    () => {},
    undefined,
    { runId: 'run-circuit', sessionId: 'session-circuit', maxIterations: 20 },
  );
  assert.equal(result.status, 'limited');
  assert.equal(result.terminationReason, 'orchestration_stalled');
  assert.equal(result.modelTurnCount, 1);
  assert.equal(result.error?.code, 'ORCHESTRATION_STALLED');
});

test('model request timeout is forwarded and cumulative token usage is bounded', async () => {
  const { host } = toolHost();
  let timeoutMs: number | undefined;
  const model: ModelClient = {
    model: 'budgeted', baseUrl: 'memory://budgeted', reasoning: { supported: 'unknown', requestMode: 'provider_default' },
    async *streamMessage(_messages, options) {
      timeoutMs = options?.timeoutMs;
      yield { version: 1, type: 'turn_started', attemptId: 'budget-attempt' };
      yield { version: 1, type: 'text_delta', delta: 'bounded answer' };
      yield { version: 1, type: 'turn_completed', response: { content: 'bounded answer', reasoning: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } } };
    },
  };
  const result = await createExecutor(host).runReActLoop(model, [{ role: 'user', content: 'work' }], () => {}, undefined, {
    modelRequestTimeoutMs: 300_000,
    maxTotalTokens: 10,
  });
  assert.equal(timeoutMs, 300_000);
  assert.equal(result.status, 'limited');
  assert.equal(result.terminationReason, 'total_token_limit');
  assert.equal(result.finalContent, 'bounded answer');
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
      requests.push((messages as ChatMessage[]).flatMap((message) => message.role === 'user' ? [message.content] : []));
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

test('settles an in-flight model request as aborted without inventing a final answer', async () => {
  const { host } = toolHost();
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const model: ModelClient = {
    model: 'abort-script',
    baseUrl: 'memory://abort-script',
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
    async *streamMessage(_messages, options): AsyncIterable<ModelEvent> {
      yield { version: 1, type: 'turn_started', attemptId: 'attempt-abort' };
      markStarted();
      if (!options?.signal?.aborted) await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new DOMException('Aborted', 'AbortError');
    },
  };
  const run = createExecutor(host).runReActLoop(model, [], () => {}, undefined, { signal: controller.signal });
  await started;
  controller.abort();
  const result = await run;

  assert.equal(result.status, 'aborted');
  assert.equal(result.terminationReason, 'user_abort');
  assert.equal(result.finalContent, '');
  assert.equal(result.finalMessageId, undefined);
});

test('keeps legacy reasoning and text streams separate while committing the complete assistant turn', async () => {
  const { host } = toolHost();
  const events: AgentEvent[] = [];
  const committed: string[] = [];
  const model: ModelClient = {
    model: 'reasoning-script',
    baseUrl: 'memory://reasoning-script',
    reasoning: { supported: true, requestMode: 'enabled' },
    async *streamMessage(): AsyncIterable<ModelEvent> {
      yield { version: 1, type: 'turn_started', attemptId: 'attempt-reasoning' };
      yield { version: 1, type: 'reasoning_delta', delta: 'private reasoning' };
      yield { version: 1, type: 'text_delta', delta: 'public answer' };
      yield {
        version: 1,
        type: 'turn_completed',
        response: {
          content: 'public answer',
          reasoning: 'private reasoning',
          toolCalls: [],
          finishReason: 'stop',
        },
      };
    },
  };

  const result = await createExecutor(host).runReActLoop(model, [], (event) => events.push(event), undefined, {
    semantic: {
      assistantCommitted: async (message) => { committed.push(message.content ?? ''); },
      toolStarted: async () => {},
      toolOutcome: async () => {},
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(events.filter((event) => event.type === 'reasoning_chunk' || event.type === 'chunk'), [
    { type: 'reasoning_chunk', chunk: 'private reasoning' },
    { type: 'chunk', chunk: 'public answer' },
  ]);
  assert.deepEqual(committed, ['public answer']);
});

test('emits stable V2 message blocks and phase transitions without mixing reasoning into text', async () => {
  const { host } = toolHost();
  const events: RunEventPayload[] = [];
  const model: ModelClient = {
    model: 'presentation-script',
    baseUrl: 'memory://presentation-script',
    reasoning: { supported: true, requestMode: 'enabled' },
    async *streamMessage(): AsyncIterable<ModelEvent> {
      yield { version: 1, type: 'turn_started', attemptId: 'attempt-presentation' };
      yield { version: 1, type: 'reasoning_delta', delta: 'reasoning' };
      yield { version: 1, type: 'text_delta', delta: 'answer' };
      yield {
        version: 1,
        type: 'turn_completed',
        response: { content: 'answer', reasoning: 'reasoning', toolCalls: [], finishReason: 'stop' },
      };
    },
  };
  const result = await createExecutor(host).runReActLoop(model, [], () => {}, undefined, {
    runId: 'run-presentation',
    presentation: { emit: (event) => events.push(event) },
    semantic: {
      assistantCommitted: async () => {},
      toolStarted: async () => {},
      toolOutcome: async () => {},
    },
  });

  assert.equal(result.finalMessageId, 'run-presentation:message:1');
  assert.deepEqual(events.filter((event) => event.type === 'run_phase_changed').map((event) => event.phase), [
    'requesting_model',
    'thinking',
    'answering',
  ]);
  const deltas = events.filter((event) => event.type === 'assistant_content_delta');
  assert.deepEqual(deltas.map((event) => [event.contentIndex, event.kind, event.delta]), [
    [0, 'reasoning', 'reasoning'],
    [1, 'text', 'answer'],
  ]);
  const committedEvent = events.find((event) => event.type === 'assistant_message_committed');
  assert.equal(committedEvent?.type, 'assistant_message_committed');
  if (committedEvent?.type === 'assistant_message_committed') {
    assert.equal(committedEvent.message.messageId, 'run-presentation:message:1');
    assert.equal(committedEvent.message.content, 'answer');
    assert.equal(committedEvent.message.contentBlocks[0]?.kind, 'reasoning');
  }
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

test('escalates 16k to 32k to 64k, then continues a length-limited response', async () => {
  const { host } = toolHost();
  const budgets: number[] = [];
  const responses: ModelResponse[] = [
    { content: 'discard-16', reasoning: '', toolCalls: [], finishReason: 'length' },
    { content: 'discard-32', reasoning: '', toolCalls: [], finishReason: 'length' },
    { content: 'first ', reasoning: '', toolCalls: [], finishReason: 'length' },
    { content: 'second', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ];
  let index = 0;
  const model: ModelClient = {
    model: 'large',
    baseUrl: 'memory://large',
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
    outputTokenLimits: { initial: 16_384, maximum: 128_000 },
    async *streamMessage(_messages, options): AsyncIterable<ModelEvent> {
      budgets.push(options?.max_tokens ?? 0);
      const response = responses[index++];
      yield { version: 1, type: 'turn_started', attemptId: `attempt-${index}` };
      if (response.content) yield { version: 1, type: 'text_delta', delta: response.content };
      yield { version: 1, type: 'turn_completed', response };
    },
  };
  const result = await createExecutor(host).runReActLoop(model, [{ role: 'user', content: 'answer' }], () => {});
  assert.equal(result.status, 'completed');
  assert.equal(result.finalContent, 'first second');
  assert.equal(result.modelTurnCount, 1);
  assert.deepEqual(budgets, [16_384, 32_768, 65_536, 65_536]);
});

test('does not impose a fixed turn limit when no model turn budget is configured', async () => {
  const { host } = toolHost();
  const turns: ModelResponse[] = Array.from({ length: 21 }, (_, index) => ({
    content: '',
    reasoning: '',
    toolCalls: [{ id: `call-${index}`, name: 'read_file', arguments: { path: 'a.ts' } }],
    finishReason: 'tool_calls',
  }));
  turns.push({ content: 'finished after twenty turns', reasoning: '', toolCalls: [], finishReason: 'stop' });
  const result = await createExecutor(host).runReActLoop(scriptedModel(turns), [], () => {});
  assert.equal(result.status, 'completed');
  assert.equal(result.modelTurnCount, 22);
  assert.equal(result.finalContent, 'finished after twenty turns');
});

test('projects a valid request from a session that already contains an orphan empty assistant message', async () => {
  const { host } = toolHost();
  const legacyMessages: ChatMessage[] = [
    { role: 'user', content: 'count the files' },
    { role: 'assistant', content: null },
    { role: 'user', content: 'why did you stop?' },
  ];

  const result = await createExecutor(host).runReActLoop(
    modelRejectingInvalidAssistantHistory('recovered'),
    legacyMessages,
    () => {},
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.finalContent, 'recovered');
  assert.deepEqual(legacyMessages[1], { role: 'assistant', content: null });
});

test('never exceeds a smaller model limit and reports exhausted continuations separately', async () => {
  const { host } = toolHost();
  const budgets: number[] = [];
  const model: ModelClient = {
    model: 'small', baseUrl: 'memory://small',
    reasoning: { supported: false, requestMode: 'disabled' },
    outputTokenLimits: { initial: 16_384, maximum: 8_192 },
    async *streamMessage(_messages, options): AsyncIterable<ModelEvent> {
      budgets.push(options?.max_tokens ?? 0);
      yield { version: 1, type: 'turn_started', attemptId: `attempt-${budgets.length}` };
      yield { version: 1, type: 'turn_completed', response: { content: '', reasoning: '', toolCalls: [], finishReason: 'length' } };
    },
  };
  const result = await createExecutor(host).runReActLoop(model, [{ role: 'user', content: 'answer' }], () => {});
  assert.equal(result.status, 'limited');
  assert.equal(result.terminationReason, 'output_token_limit');
  assert.deepEqual(budgets, [8_192, 8_192, 8_192, 8_192]);
  assert.equal(result.modelTurnCount, 1);
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
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
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
    async prepare(input) {
      forceFlags.push(input.forceSummary);
      timeline.push(`prepare-${input.turn}`);
      return preparedWithActivity(input, input.forceSummary === true);
    },
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
  const contextEvents = events.filter((event) => event.type === 'context_activity');
  assert.equal(contextEvents.length, 1);
  assert.equal(contextEvents[0]?.type === 'context_activity' ? contextEvents[0].presentation.summarizedMessages : 0, 4);
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
