import { createOpenAiCompatibleModelClient } from './openai.ts';
import { createMockModelClient } from './mock.ts';
import type { ModelClient } from './types.ts';

export type { ModelClient, ChatOptions } from './types.ts';
export { createOpenAiCompatibleModelClient } from './openai.ts';
export { createMockModelClient } from './mock.ts';

function getEnv(name: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : '';
}

function getEnvNumber(name: string): number | undefined {
  const value = getEnv(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function createModelClient(): ModelClient {
  const apiKey = getEnv('LLM_API_KEY') || getEnv('DOUBAO_API_KEY');
  const model = getEnv('LLM_MODEL') || getEnv('DOUBAO_MODEL');
  const provider = getEnv('LLM_PROVIDER') || (getEnv('DOUBAO_API_KEY') ? 'doubao' : '');

  const defaultBaseUrl = provider === 'doubao'
    ? 'https://ark.cn-beijing.volces.com/api/v3'
    : 'https://api.openai.com/v1';
  const baseUrl = getEnv('LLM_BASE_URL') || getEnv('DOUBAO_BASE_URL') || defaultBaseUrl;

  if (!apiKey || !model) {
    return createMockModelClient();
  }

  return createOpenAiCompatibleModelClient({
    baseUrl,
    apiKey,
    model,
    doubaoCompat: provider === 'doubao',
    defaults: {
      temperature: getEnvNumber('LLM_TEMPERATURE'),
      top_p: getEnvNumber('LLM_TOP_P'),
      max_tokens: getEnvNumber('LLM_MAX_TOKENS'),
      timeout: getEnvNumber('LLM_TIMEOUT'),
      max_retries: getEnvNumber('LLM_MAX_RETRIES'),
    },
  });
}
