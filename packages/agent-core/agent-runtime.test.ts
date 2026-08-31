import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatOptions, ModelClient, ModelEvent, ModelResponse } from '../llm-client/index.ts';
import type { ChatMessage } from '../shared/types.ts';
import { createAgentRuntime } from './agent-runtime.ts';

function host() {
  let writes = 0;
  return {
    toolHost: {
      readFile: (path: string) => ({ path, content: 'hello' }),
      writeFile: () => { writes += 1; return { ok: true }; },
      runCommand: () => ({ ok: true }),
      listWorkspace: () => ['README.md'],
      searchInWorkspace: () => [],
      patchFile: () => ({ ok: true }),
      listVersions: () => [],
      createSnapshot: () => ({ ok: true }),
      restoreSnapshot: () => ({ ok: true }),
    },
    writes: () => writes,
  };
}

function scriptedModel(
  responses: ModelResponse[],
  observe?: (messages: ChatMessage[], options?: ChatOptions) => void,
): ModelClient {
  let index = 0;
  return {
    model: 'runtime-test',
    baseUrl: 'memory://runtime-test',
    maxOutputTokens: 2048,
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
    async *streamMessage(messages, options): AsyncIterable<ModelEvent> {
      observe?.(messages as ChatMessage[], options);
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

const noPersistence = {
  assistantCommitted: async () => {},
  toolStarted: async () => {},
  toolOutcome: async () => {},
};

test('internal readonly Agent has isolated context, lineage, tools and persistence', async () => {
  const item = host();
  const requests: Array<{ messages: ChatMessage[]; tools: string[]; maxTokens?: number }> = [];
  const model = scriptedModel([
    {
      content: '',
      reasoning: '',
      toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    },
    {
      content: 'internal complete',
      reasoning: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    },
  ], (messages, options) => {
    requests.push({
      messages,
      tools: ((options?.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
      ...(options?.max_tokens !== undefined ? { maxTokens: options.max_tokens } : {}),
    });
  });
  const parentMessages: ChatMessage[] = [{ role: 'user', content: 'parent transcript' }];
  const runtimeEvents: string[] = [];
  const runtime = createAgentRuntime({ toolHost: item.toolHost, modelClient: model });

  const result = await runtime.runInternalAgent({
    runId: 'child-run',
    parentRunId: 'main-run',
    messages: [{ role: 'user', content: 'inspect only' }],
    systemSections: [{ source: 'systemPrompt', content: 'INTERNAL ONLY' }],
    budget: { maxModelTurns: 3, maxOutputTokens: 321 },
    onEvent: (event) => { runtimeEvents.push(event.type); },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.finalContent, 'internal complete');
  assert.equal(result.runId, 'child-run');
  assert.equal(result.parentRunId, 'main-run');
  assert.equal(result.profile, 'internal-readonly');
  assert.equal(result.origin, 'internal');
  assert.deepEqual(result.toolsUsed, ['read_file']);
  assert.deepEqual(parentMessages, [{ role: 'user', content: 'parent transcript' }]);
  assert.deepEqual(requests[0]?.messages.slice(0, 2), [
    { role: 'system', content: 'INTERNAL ONLY' },
    { role: 'user', content: 'inspect only' },
  ]);
  assert.deepEqual(requests[0]?.tools.sort(), ['list_workspace', 'read_file', 'search_in_workspace']);
  assert.equal(requests[0]?.maxTokens, 321);
  assert.equal(requests[0]?.messages.some((message) => message.role === 'system' && /Available Skills|Recent Tasks|Project Memory/.test(message.content)), false);
  assert.deepEqual(runtimeEvents, [
    'agent_start',
    'tool_call_requested',
    'tool_finished',
    'turn_end',
    'turn_end',
    'agent_end',
  ]);
});

test('readonly policy rejects a fabricated write call on the execution path', async () => {
  const item = host();
  const visibleTools: string[][] = [];
  const model = scriptedModel([
    {
      content: '',
      reasoning: '',
      toolCalls: [{ id: 'write-forbidden', name: 'write_file', arguments: { path: 'x.ts', content: 'bad' } }],
      finishReason: 'tool_calls',
    },
    { content: 'handled', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ], (_messages, options) => {
    visibleTools.push(((options?.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name));
  });
  const runtime = createAgentRuntime({ toolHost: item.toolHost, modelClient: model });

  const result = await runtime.runInternalAgent({
    messages: [{ role: 'user', content: 'try a write' }],
  });

  assert.equal(result.status, 'completed');
  assert.equal(item.writes(), 0);
  assert.equal(visibleTools.every((tools) => !tools.includes('write_file')), true);
  const rejection = result.messages.find((message) => message.role === 'tool' && message.name === 'write_file');
  assert.match(rejection?.content ?? '', /tool forbidden by policy/);
});

test('budgets and abort signals are scoped to an individual internal Run', async () => {
  const item = host();
  const looping = scriptedModel([
    { content: '', reasoning: '', toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'a' } }], finishReason: 'tool_calls' },
  ]);
  const runtime = createAgentRuntime({ toolHost: item.toolHost, modelClient: looping });
  const limited = await runtime.runInternalAgent({
    messages: [{ role: 'user', content: 'loop' }],
    budget: { maxModelTurns: 1 },
  });
  assert.equal(limited.status, 'limited');
  assert.equal(limited.modelTurnCount, 1);

  const controller = new AbortController();
  const abortingModel: ModelClient = {
    model: 'abort-test',
    baseUrl: 'memory://abort-test',
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
    async *streamMessage(_messages, options): AsyncIterable<ModelEvent> {
      yield { version: 1, type: 'turn_started', attemptId: 'abort-attempt' };
      controller.abort();
      if (options?.signal?.aborted) {
        yield { version: 1, type: 'turn_failed', failure: { category: 'cancelled', retryable: false, message: 'cancelled' } };
      }
    },
  };
  const aborted = await runtime.runInternalAgent({
    messages: [{ role: 'user', content: 'abort me' }],
    modelClient: abortingModel,
    signal: controller.signal,
  });
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.terminationReason, 'user_abort');
});

test('a user Agent end hook can run one internal child and failures stay isolated', async () => {
  const item = host();
  const mainModel = scriptedModel([
    { content: 'main complete', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  const childModel = scriptedModel([
    { content: 'child complete', reasoning: '', toolCalls: [], finishReason: 'stop' },
  ]);
  const runtime = createAgentRuntime({ toolHost: item.toolHost, modelClient: mainModel });
  let hookCalls = 0;
  let childResult = '';

  const main = await runtime.runAgent({
    identity: { runId: 'main-run', profile: 'main', origin: 'user' },
    messages: [{ role: 'user', content: 'finish main' }],
    persistence: 'session',
    persistenceHooks: noPersistence,
    budget: { maxModelTurns: 2 },
    lifecycle: {
      onAgentEnd: async (event) => {
        hookCalls += 1;
        const child = await runtime.runInternalAgent({
          parentRunId: event.identity.runId,
          messages: [{ role: 'user', content: 'post-run work' }],
          modelClient: childModel,
        });
        childResult = child.finalContent;
        throw new Error('extension failed after child completion');
      },
    },
  });

  assert.equal(main.status, 'completed');
  assert.equal(main.finalContent, 'main complete');
  assert.equal(hookCalls, 1);
  assert.equal(childResult, 'child complete');
  assert.deepEqual(main.runtimeWarnings, [{ stage: 'agent_end', message: 'extension failed after child completion' }]);
});
