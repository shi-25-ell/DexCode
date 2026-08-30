export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ModelFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: JsonObject;
};

export type ModelResponse = {
  content: string;
  reasoning: string;
  toolCalls: ModelToolCall[];
  finishReason: ModelFinishReason;
  usage?: ModelUsage;
};

export type ModelFailure = {
  category:
    | 'not_configured'
    | 'authentication'
    | 'permission'
    | 'rate_limit'
    | 'quota'
    | 'timeout'
    | 'network'
    | 'invalid_request'
    | 'invalid_response'
    | 'content_filter'
    | 'provider_unavailable'
    | 'cancelled'
    | 'adapter_bug';
  retryable: boolean;
  message: string;
  retryAfterMs?: number;
  httpStatus?: number;
  requestId?: string;
};

export type ModelEvent =
  | { version: 1; type: 'turn_started'; attemptId: string }
  | { version: 1; type: 'text_delta'; delta: string }
  | { version: 1; type: 'reasoning_delta'; delta: string }
  | {
      version: 1;
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { version: 1; type: 'turn_completed'; response: ModelResponse }
  | { version: 1; type: 'turn_failed'; failure: ModelFailure };

export type ModelTurnResult =
  | { status: 'completed'; response: ModelResponse }
  | { status: 'failed'; failure: ModelFailure; producedSemanticOutput: boolean };

export type ChatOptions = {
  tools?: unknown[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  thinking?: { type: string };
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream_options?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ModelClient = {
  readonly model: string;
  readonly baseUrl: string;
  streamMessage(messages: unknown[], options?: ChatOptions): AsyncIterable<ModelEvent>;
};
