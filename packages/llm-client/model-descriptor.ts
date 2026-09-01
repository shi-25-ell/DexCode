export type KnownModelDescriptor = {
  displayName: string;
  contextWindow?: number;
  outputTokens?: { initial: number; maximum: number };
  reasoning: import('./types.ts').ReasoningCapability;
};

const KNOWN_MODELS: Record<string, KnownModelDescriptor> = {
  'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash', contextWindow: 1_000_000, outputTokens: { initial: 16_384, maximum: 384_000 }, reasoning: { supported: 'unknown', requestMode: 'provider_default' } },
  'deepseek-v4-pro': { displayName: 'DeepSeek V4 Pro', contextWindow: 1_000_000, outputTokens: { initial: 16_384, maximum: 384_000 }, reasoning: { supported: 'unknown', requestMode: 'provider_default' } },
  'deepseek-v4-flash-vision-exp': { displayName: 'DeepSeek V4 Flash Vision', contextWindow: 1_000_000, outputTokens: { initial: 16_384, maximum: 384_000 }, reasoning: { supported: 'unknown', requestMode: 'provider_default' } },
};

export function describeModel(model: string, baseUrl: string): KnownModelDescriptor {
  const known = KNOWN_MODELS[model.trim().toLowerCase()];
  if (!known) return { displayName: model, reasoning: { supported: 'unknown', requestMode: 'provider_default' } };

  // Official values only apply to DeepSeek's own endpoint. Compatible gateways
  // may reuse the model name for deployments with a different context window.
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return { ...known };
  } catch {
    // The request adapter owns base URL validation.
  }
  return { displayName: known.displayName, reasoning: known.reasoning };
}
