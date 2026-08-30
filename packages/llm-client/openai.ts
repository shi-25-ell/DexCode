import type { ChatOptions, ModelClient } from './types.ts';

type OpenAiCompatibleModelOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  doubaoCompat?: boolean;
  defaults?: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    timeout?: number;
    max_retries?: number;
  };
};

function parseSseChunk(buffer: string) {
  const events: string[] = [];
  const lines = buffer.split(/\r?\n/);
  let current = '';

  for (const line of lines) {
    if (!line.trim()) {
      if (current.trim()) {
        events.push(current.trim());
        current = '';
      }
      continue;
    }
    if (line.startsWith('data:')) {
      current += `${line.slice(5).trim()}\n`;
    }
  }

  return { events, remainder: current };
}

export function createOpenAiCompatibleModelClient(options: OpenAiCompatibleModelOptions): ModelClient {
  const { baseUrl, apiKey, model, doubaoCompat = false, defaults = {} } = options;

  async function chatCompletions(payload: Record<string, unknown>, stream: boolean) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify({ model, ...payload }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`);
    }

    return response;
  }

  async function createMessage(messages: unknown[], options: ChatOptions = {}) {
    const payload: Record<string, unknown> = {
      messages,
      temperature: options.temperature ?? defaults.temperature ?? 0.7,
      top_p: options.top_p ?? defaults.top_p,
      max_tokens: options.max_tokens ?? defaults.max_tokens ?? 4096,
    };

    if (payload.top_p === undefined) delete payload.top_p;

    if (doubaoCompat || options.thinking) {
      payload.thinking = options.thinking ?? { type: 'enabled' };
    }
    if (doubaoCompat || options.reasoning_effort) {
      payload.reasoning_effort = options.reasoning_effort ?? 'medium';
    }

    if (options.tools) payload.tools = options.tools;
    if (options.tool_choice) payload.tool_choice = options.tool_choice;
    if (options.parallel_tool_calls !== undefined) payload.parallel_tool_calls = options.parallel_tool_calls;
    if (options.stream_options) payload.stream_options = options.stream_options;

    const response = await chatCompletions(payload, false);
    return response.json();
  }

  async function* streamMessage(messages: unknown[], options: ChatOptions = {}) {
    const payload: Record<string, unknown> = {
      messages,
      temperature: options.temperature ?? defaults.temperature ?? 0.7,
      top_p: options.top_p ?? defaults.top_p,
      max_tokens: options.max_tokens ?? defaults.max_tokens ?? 4096,
      stream_options: options.stream_options ?? { include_usage: true },
    };

    if (payload.top_p === undefined) delete payload.top_p;

    if (doubaoCompat || options.thinking) {
      payload.thinking = options.thinking ?? { type: 'enabled' };
    }
    if (doubaoCompat || options.reasoning_effort) {
      payload.reasoning_effort = options.reasoning_effort ?? 'medium';
    }

    if (options.tools) payload.tools = options.tools;
    if (options.tool_choice) payload.tool_choice = options.tool_choice;
    if (options.parallel_tool_calls !== undefined) payload.parallel_tool_calls = options.parallel_tool_calls;

    const response = await chatCompletions(payload, true);
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSseChunk(buffer);
      buffer = remainder;

      for (const event of events) {
        if (event === '[DONE]') return;
        try {
          const json = JSON.parse(event) as { choices?: Array<{ delta?: unknown }> };
          const delta = json?.choices?.[0]?.delta;
          if (delta) yield delta;
        } catch {
          continue;
        }
      }
    }
  }

  return { model, baseUrl, createMessage, streamMessage };
}
