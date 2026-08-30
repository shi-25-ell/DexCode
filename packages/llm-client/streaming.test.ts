import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAiCompatibleModelClient } from './openai.ts';
import { collectModelTurn, ModelTurnAccumulator } from './turn-accumulator.ts';

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('accumulator rejects a stream without terminal event', () => {
  const accumulator = new ModelTurnAccumulator();
  accumulator.accept({ version: 1, type: 'turn_started', attemptId: 'attempt-1' });
  accumulator.accept({ version: 1, type: 'text_delta', delta: 'partial' });
  assert.throws(() => accumulator.result(), /without terminal/);
});

test('OpenAI-compatible stream survives arbitrary SSE fragmentation and assembles tool calls', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => responseFromChunks([
    'data: {"choices":[{"delta":{"content":"hel',
    'lo"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ])) as typeof fetch;
  try {
    const model = createOpenAiCompatibleModelClient({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const turn = await collectModelTurn(model.streamMessage([], { tools: [] }));
    assert.equal(turn.status, 'completed');
    if (turn.status !== 'completed') return;
    assert.equal(turn.response.content, 'hello');
    assert.deepEqual(turn.response.toolCalls, [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }]);
    assert.equal(turn.response.usage?.totalTokens, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI-compatible stream reports an interrupted SSE event as invalid response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => responseFromChunks(['data: {"choices":'])) as typeof fetch;
  try {
    const model = createOpenAiCompatibleModelClient({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const turn = await collectModelTurn(model.streamMessage([]));
    assert.equal(turn.status, 'failed');
    if (turn.status === 'failed') assert.equal(turn.failure.category, 'invalid_response');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
