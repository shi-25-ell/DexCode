import { createHash } from 'node:crypto';
import { createOpenAiCompatibleModelClient } from './openai.ts';
import { createMockModelClient } from './mock.ts';
import type { ModelClient } from './types.ts';
import { describeModel } from './model-descriptor.ts';

export type PublicModelDescriptor = {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type ModelCatalog = {
  defaultModel: string;
  models: PublicModelDescriptor[];
  warning?: string;
};

export type ModelRegistry = {
  readonly connectionFingerprint: string;
  readonly defaultModel: string;
  readonly defaultClient: ModelClient;
  listModels(options?: { refresh?: boolean }): Promise<ModelCatalog>;
  assertSelectable(model: string): Promise<ModelClient>;
  clientFor(model?: string): ModelClient;
};

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
  ReasoningCapability,
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

function reasoningCapability(defaultValue: import('./types.ts').ReasoningCapability): import('./types.ts').ReasoningCapability {
  const supportedValue = getEnv('LLM_REASONING_SUPPORTED').toLowerCase();
  const modeValue = getEnv('LLM_REASONING_MODE').toLowerCase();
  const supported = supportedValue === 'true' ? true : supportedValue === 'false' ? false : defaultValue.supported;
  const requestMode = modeValue === 'enabled' || modeValue === 'disabled' || modeValue === 'provider_default'
    ? modeValue
    : defaultValue.requestMode;
  return { supported, requestMode };
}

type ModelEnvironment = {
  apiKey: string;
  defaultModel: string;
  provider: string;
  baseUrl: string;
  configuredMaximum?: number;
  configuredContextWindow?: number;
  providerDisplayName?: string;
  defaultDisplayName?: string;
  defaults: {
    temperature?: number;
    top_p?: number;
    timeout?: number;
  };
};

function modelEnvironment(): ModelEnvironment | undefined {
  const apiKey = getEnv('LLM_API_KEY') || getEnv('DOUBAO_API_KEY');
  const defaultModel = getEnv('LLM_MODEL') || getEnv('DOUBAO_MODEL');
  const provider = getEnv('LLM_PROVIDER') || (getEnv('DOUBAO_API_KEY') ? 'doubao' : '');
  const defaultBaseUrl = provider === 'doubao'
    ? 'https://ark.cn-beijing.volces.com/api/v3'
    : 'https://api.openai.com/v1';
  const baseUrl = getEnv('LLM_BASE_URL') || getEnv('DOUBAO_BASE_URL') || defaultBaseUrl;
  if (!apiKey || !defaultModel) return undefined;
  return {
    apiKey,
    defaultModel,
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    configuredMaximum: getEnvNumber('LLM_MAX_OUTPUT_TOKENS') ?? getEnvNumber('LLM_MAX_TOKENS'),
    configuredContextWindow: getEnvNumber('LLM_CONTEXT_WINDOW'),
    providerDisplayName: getEnv('LLM_PROVIDER_DISPLAY_NAME') || undefined,
    defaultDisplayName: getEnv('LLM_DISPLAY_NAME') || undefined,
    defaults: {
      temperature: getEnvNumber('LLM_TEMPERATURE'),
      top_p: getEnvNumber('LLM_TOP_P'),
      timeout: getEnvNumber('LLM_TIMEOUT'),
    },
  };
}

function configuredClient(environment: ModelEnvironment, model: string): ModelClient {
  const descriptor = describeModel(model, environment.baseUrl);
  const { configuredMaximum } = environment;
  const descriptorMaximum = descriptor.outputTokens?.maximum;
  const maximum = Math.max(1, Math.floor(
    configuredMaximum !== undefined && descriptorMaximum !== undefined
      ? Math.min(configuredMaximum, descriptorMaximum)
      : configuredMaximum ?? descriptorMaximum ?? 16_384,
  ));
  const initial = Math.min(16_384, descriptor.outputTokens?.initial ?? 16_384, maximum);
  return createOpenAiCompatibleModelClient({
    baseUrl: environment.baseUrl,
    apiKey: environment.apiKey,
    model,
    displayName: model === environment.defaultModel
      ? environment.defaultDisplayName ?? descriptor.displayName
      : descriptor.displayName,
    contextWindow: environment.configuredContextWindow ?? descriptor.contextWindow,
    providerDisplayName: environment.providerDisplayName,
    reasoning: reasoningCapability(descriptor.reasoning),
    outputTokenLimits: { initial, maximum },
    doubaoCompat: environment.provider === 'doubao',
    defaults: {
      temperature: environment.defaults.temperature,
      top_p: environment.defaults.top_p,
      max_tokens: initial,
      timeout: environment.defaults.timeout,
    },
  });
}

export function createModelClient(): ModelClient {
  const environment = modelEnvironment();
  return environment ? configuredClient(environment, environment.defaultModel) : createMockModelClient();
}

const MODEL_CATALOG_TTL_MS = 5 * 60_000;

function publicDescriptor(client: ModelClient): PublicModelDescriptor {
  return {
    id: client.model,
    displayName: client.displayName ?? client.model,
    ...(client.contextWindow !== undefined ? { contextWindow: client.contextWindow } : {}),
    ...(client.maxOutputTokens !== undefined ? { maxOutputTokens: client.maxOutputTokens } : {}),
  };
}

export function createModelRegistry(options: { fetch?: typeof fetch; now?: () => number } = {}): ModelRegistry {
  const environment = modelEnvironment();
  const connectionFingerprint = createHash('sha256').update(JSON.stringify({
    version: 1,
    provider: environment?.provider ?? 'mock',
    baseUrl: environment?.baseUrl ?? 'mock',
    apiKey: environment?.apiKey ?? 'mock',
  })).digest('hex');
  const defaultClient = environment ? configuredClient(environment, environment.defaultModel) : createMockModelClient();
  const defaultModel = defaultClient.model;
  const clients = new Map<string, ModelClient>([[defaultModel, defaultClient]]);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { at: number; catalog: ModelCatalog } | undefined;

  const clientFor = (model = defaultModel): ModelClient => {
    const normalized = model.trim();
    if (!normalized) throw new Error('Model ID cannot be empty');
    const existing = clients.get(normalized);
    if (existing) return existing;
    if (!environment) throw new Error('No LLM credentials are configured');
    const client = configuredClient(environment, normalized);
    clients.set(normalized, client);
    return client;
  };

  const listModels = async (listOptions: { refresh?: boolean } = {}): Promise<ModelCatalog> => {
    if (!listOptions.refresh && cached && now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.catalog;
    if (!environment) {
      const catalog = { defaultModel, models: [publicDescriptor(defaultClient)] };
      cached = { at: now(), catalog };
      return catalog;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await fetcher(`${environment.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${environment.apiKey}`, Accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`模型列表请求失败（${response.status}）`);
      const payload = await response.json() as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(payload.data)) throw new Error('模型列表响应缺少 data 数组');
      const ids = [defaultModel, ...payload.data.flatMap((item) => typeof item.id === 'string' && item.id.trim() ? [item.id.trim()] : [])];
      const unique = ids.filter((id, index) => ids.findIndex((candidate) => candidate.toLocaleLowerCase() === id.toLocaleLowerCase()) === index);
      const catalog = { defaultModel, models: unique.map((id) => publicDescriptor(clientFor(id))) };
      cached = { at: now(), catalog };
      return catalog;
    } catch (error) {
      const catalog = {
        defaultModel,
        models: [publicDescriptor(defaultClient)],
        warning: `无法读取厂商模型列表，仅提供默认模型：${error instanceof Error ? error.message : String(error)}`,
      };
      cached = { at: now(), catalog };
      return catalog;
    }
  };

  return {
    connectionFingerprint,
    defaultModel,
    defaultClient,
    listModels,
    clientFor,
    async assertSelectable(model) {
      const normalized = model.trim();
      const catalog = await listModels();
      if (!catalog.models.some((candidate) => candidate.id === normalized)) {
        throw new Error(`模型不可用：${normalized || '(empty)'}`);
      }
      return clientFor(normalized);
    },
  };
}
