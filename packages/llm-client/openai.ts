import type {
  ChatOptions,
  ModelClient,
  ModelEvent,
  ModelFailure,
  ModelFinishReason,
  ModelResponse,
  ModelUsage,
  ReasoningCapability,
} from './types.ts';

type OpenAiCompatibleModelOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  displayName?: string;
  contextWindow?: number;
  providerDisplayName?: string;
  doubaoCompat?: boolean;
  reasoning?: ReasoningCapability;
  defaults?: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    timeout?: number;
  };
};

class OpenAiWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAiWireError';
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new OpenAiWireError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finishReason(value: unknown): ModelFinishReason {
  if (value === 'stop' || value === 'tool_calls' || value === 'length' || value === 'content_filter') {
    return value;
  }
  if (value === 'function_call') return 'tool_calls';
  if (typeof value === 'string') return 'unknown';
  throw new OpenAiWireError('finish_reason is missing');
}

function usage(value: unknown): ModelUsage {
  const raw = object(value, 'usage');
  const number = (key: string): number | undefined =>
    typeof raw[key] === 'number' ? raw[key] as number : undefined;
  return {
    ...(number('prompt_tokens') !== undefined ? { inputTokens: number('prompt_tokens') } : {}),
    ...(number('completion_tokens') !== undefined ? { outputTokens: number('completion_tokens') } : {}),
    ...(number('total_tokens') !== undefined ? { totalTokens: number('total_tokens') } : {}),
  };
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
    if (buffer.trim()) throw new OpenAiWireError('SSE stream ended inside an event');
  } finally {
    reader.releaseLock();
  }
}

function isContextOverflowBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const raw = JSON.stringify(body).toLowerCase();
  return [
    'context_length_exceeded',
    'context window',
    'maximum context length',
    'prompt is too long',
    'input is too long',
  ].some((marker) => raw.includes(marker));
}

function httpFailure(status: number, statusText: string, retryAfter: string | null, body?: unknown): ModelFailure {
  const common = { httpStatus: status, message: `LLM request failed: ${status} ${statusText}` };
  if (isContextOverflowBody(body)) return { ...common, category: 'context_overflow', retryable: false };
  if (status === 401) return { ...common, category: 'authentication', retryable: false };
  if (status === 403) return { ...common, category: 'permission', retryable: false };
  if (status === 429) {
    const seconds = retryAfter === null ? undefined : Number(retryAfter);
    return {
      ...common,
      category: 'rate_limit',
      retryable: true,
      ...(Number.isFinite(seconds) ? { retryAfterMs: Math.max(0, seconds as number) * 1000 } : {}),
    };
  }
  if (status === 408) return { ...common, category: 'timeout', retryable: true };
  if (status >= 500) return { ...common, category: 'provider_unavailable', retryable: true };
  return { ...common, category: 'invalid_request', retryable: false };
}

function thrownFailure(error: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): ModelFailure {
  if (callerSignal?.aborted) return { category: 'cancelled', retryable: false, message: 'Model request cancelled' };
  if (timeoutSignal.aborted) return { category: 'timeout', retryable: true, message: 'Model request timed out' };
  if (error instanceof OpenAiWireError || error instanceof SyntaxError) {
    return { category: 'invalid_response', retryable: false, message: error.message };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { category: 'cancelled', retryable: false, message: 'Model request cancelled' };
  }
  return {
    category: 'network',
    retryable: true,
    message: error instanceof Error ? error.message : 'Model request failed',
  };
}

export function createOpenAiCompatibleModelClient(options: OpenAiCompatibleModelOptions): ModelClient {
  const { baseUrl, apiKey, model, displayName, contextWindow, providerDisplayName, doubaoCompat = false, defaults = {} } = options;
  const reasoning = options.reasoning ?? { supported: 'unknown' as const, requestMode: 'provider_default' as const };
  if (reasoning.supported === false && reasoning.requestMode === 'enabled') {
    throw new Error('Reasoning cannot be enabled for a model declared unsupported');
  }

  async function chatCompletions(payload: Record<string, unknown>, signal: AbortSignal) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ model, ...payload, stream: true }),
      signal,
    });
    return response;
  }

  function payload(messages: unknown[], options: ChatOptions): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      messages,
      temperature: options.temperature ?? defaults.temperature ?? 0.7,
      top_p: options.top_p ?? defaults.top_p,
      max_tokens: options.max_tokens ?? defaults.max_tokens ?? 4096,
      stream_options: options.stream_options ?? { include_usage: true },
    };
    if (payload.top_p === undefined) delete payload.top_p;
    if ((doubaoCompat && reasoning.requestMode !== 'disabled') || options.thinking) {
      payload.thinking = options.thinking ?? { type: 'enabled' };
    }
    if ((doubaoCompat && reasoning.requestMode !== 'disabled') || reasoning.requestMode === 'enabled' || options.reasoning_effort) {
      payload.reasoning_effort = options.reasoning_effort ?? 'medium';
    }

    if (options.tools) payload.tools = options.tools;
    if (options.tool_choice) payload.tool_choice = options.tool_choice;
    if (options.parallel_tool_calls !== undefined) payload.parallel_tool_calls = options.parallel_tool_calls;
    return payload;
  }

  async function* streamMessage(messages: unknown[], options: ChatOptions = {}): AsyncIterable<ModelEvent> {
    yield { version: 1, type: 'turn_started', attemptId: crypto.randomUUID() };
    const timeoutMs = options.timeoutMs ?? defaults.timeout ?? 120_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await chatCompletions(payload(messages, options), signal);
      if (!response.ok) {
        let errorBody: unknown;
        try { errorBody = JSON.parse(await response.text()); } catch { errorBody = undefined; }
        yield {
          version: 1,
          type: 'turn_failed',
          failure: httpFailure(response.status, response.statusText, response.headers.get('retry-after'), errorBody),
        };
        return;
      }
      if (!response.body) throw new OpenAiWireError('response body is missing');

      let content = '';
      let reasoning = '';
      const calls = new Map<number, { id: string; name: string; argumentsText: string }>();
      let terminalReason: ModelFinishReason | undefined;
      let finalUsage: ModelUsage | undefined;
      let doneSeen = false;

      for await (const data of sseData(response.body)) {
        if (data === '[DONE]') {
          doneSeen = true;
          break;
        }
        const chunk = object(JSON.parse(data), 'stream chunk');
        if (chunk.usage !== undefined && chunk.usage !== null) finalUsage = usage(chunk.usage);
        const choices = chunk.choices;
        if (!Array.isArray(choices) || choices.length === 0) continue;
        const choice = object(choices[0], 'choice');
        const delta = object(choice.delta ?? {}, 'choice.delta');
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          yield { version: 1, type: 'text_delta', delta: delta.content };
        }
        const reasoningValue = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoningValue === 'string' && reasoningValue) {
          reasoning += reasoningValue;
          yield { version: 1, type: 'reasoning_delta', delta: reasoningValue };
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new OpenAiWireError('tool_calls must be an array');
          for (const rawCall of delta.tool_calls) {
            const call = object(rawCall, 'tool call delta');
            if (!Number.isSafeInteger(call.index) || (call.index as number) < 0) {
              throw new OpenAiWireError('tool call index is invalid');
            }
            const index = call.index as number;
            const fn = object(call.function ?? {}, 'tool call function');
            const current = calls.get(index) ?? { id: '', name: '', argumentsText: '' };
            const id = typeof call.id === 'string' ? call.id : undefined;
            const name = typeof fn.name === 'string' ? fn.name : undefined;
            const argumentsDelta = typeof fn.arguments === 'string' ? fn.arguments : undefined;
            if (id) current.id = id;
            if (name) current.name = name;
            if (argumentsDelta) current.argumentsText += argumentsDelta;
            calls.set(index, current);
            yield { version: 1, type: 'tool_call_delta', index, ...(id ? { id } : {}), ...(name ? { name } : {}), ...(argumentsDelta !== undefined ? { argumentsDelta } : {}) };
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          terminalReason = finishReason(choice.finish_reason);
        }
      }
      if (!doneSeen) throw new OpenAiWireError('stream ended without [DONE]');
      if (!terminalReason) throw new OpenAiWireError('stream ended without finish_reason');
      const responseValue: ModelResponse = {
        content,
        reasoning,
        toolCalls: [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => {
          if (!call.id || !call.name) throw new OpenAiWireError('tool call identity is incomplete');
          const parsed: unknown = JSON.parse(call.argumentsText || '{}');
          if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
            throw new OpenAiWireError('tool arguments must be a JSON object');
          }
          return { id: call.id, name: call.name, arguments: parsed as never };
        }),
        finishReason: terminalReason,
        ...(finalUsage ? { usage: finalUsage } : {}),
      };
      yield { version: 1, type: 'turn_completed', response: responseValue };
    } catch (error) {
      yield {
        version: 1,
        type: 'turn_failed',
        failure: thrownFailure(error, options.signal, timeoutSignal),
      };
    }
  }

  return {
    model,
    baseUrl,
    displayName: displayName ?? model,
    contextWindow,
    maxOutputTokens: defaults.max_tokens ?? 4096,
    providerDisplayName,
    reasoning,
    streamMessage,
  };
}
