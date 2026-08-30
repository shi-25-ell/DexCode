import { createOpenAiCompatibleModelClient } from './openai.ts';
import { createMockModelClient } from './mock.ts';
import type { ModelClient } from './types.ts';
import { describeModel } from './model-descriptor.ts';

export type {
  ChatOptions,
  JsonObject,
  JsonValue,
  ModelClient,
  ModelEvent,
  ModelFailure,
  ModelFinishReason,
  ModelResponse,
  ModelToolCall,
  ModelTurnResult,
  ModelUsage,
} from './types.ts';
export { collectModelTurn, ModelProtocolError, ModelTurnAccumulator } from './turn-accumulator.ts';
export { createOpenAiCompatibleModelClient } from './openai.ts';
export { createMockModelClient } from './mock.ts';
export { describeModel } from './model-descriptor.ts';

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

  const descriptor = describeModel(model, baseUrl);
  return createOpenAiCompatibleModelClient({
    baseUrl,
    apiKey,
    model,
    displayName: getEnv('LLM_DISPLAY_NAME') || descriptor.displayName,
    contextWindow: getEnvNumber('LLM_CONTEXT_WINDOW') ?? descriptor.contextWindow,
    providerDisplayName: getEnv('LLM_PROVIDER_DISPLAY_NAME') || undefined,
    doubaoCompat: provider === 'doubao',
    defaults: {
      temperature: getEnvNumber('LLM_TEMPERATURE'),
      top_p: getEnvNumber('LLM_TOP_P'),
      max_tokens: getEnvNumber('LLM_MAX_TOKENS'),
      timeout: getEnvNumber('LLM_TIMEOUT'),
    },
  });
}
