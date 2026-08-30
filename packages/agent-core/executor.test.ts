import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutor } from './executor.ts';
import type { ModelClient, ModelEvent, ModelResponse } from '../llm-client/index.ts';

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
