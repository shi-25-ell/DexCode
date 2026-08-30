import type { ModelClient } from './types.ts';

export function createMockModelClient(): ModelClient {
  return {
    model: 'mock',
    baseUrl: 'mock://localhost',

    async createMessage(_messages, _options) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: '[Mock LLM] No API credentials configured.',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },

    async *streamMessage(_messages, _options) {
      const content = '[Mock LLM] No API credentials configured.';
      yield { version: 1, type: 'turn_started', attemptId: 'mock-attempt' } as const;
      yield { version: 1, type: 'text_delta', delta: content } as const;
      yield {
        version: 1,
        type: 'turn_completed',
        response: {
          content,
          reasoning: '',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      } as const;
    },
  };
}
