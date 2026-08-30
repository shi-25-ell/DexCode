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
};

export type ModelClient = {
  readonly model: string;
  readonly baseUrl: string;
  createMessage(messages: unknown[], options?: ChatOptions): Promise<unknown>;
  streamMessage(messages: unknown[], options?: ChatOptions): AsyncGenerator<unknown>;
};
