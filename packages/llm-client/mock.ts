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
      yield { role: 'assistant', content: '[Mock LLM] No API credentials configured.' };
    },
  };
}
