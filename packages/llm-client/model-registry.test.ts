import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRegistry } from './index.ts';

const KEYS = [
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_BASE_URL',
  'LLM_DISPLAY_NAME',
  'LLM_CONTEXT_WINDOW',
  'LLM_MAX_OUTPUT_TOKENS',
  'DOUBAO_API_KEY',
  'DOUBAO_MODEL',
  'DOUBAO_BASE_URL',
] as const;

async function withModelEnvironment(run: () => Promise<void>) {
  const before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    process.env.LLM_API_KEY = 'secret';
    process.env.LLM_MODEL = 'vendor-pro';
    process.env.LLM_BASE_URL = 'https://vendor.example/v1/';
    process.env.LLM_DISPLAY_NAME = 'Vendor Pro';
    process.env.LLM_CONTEXT_WINDOW = '64000';
    await run();
  } finally {
    for (const key of KEYS) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('model registry keeps LLM_MODEL first and creates clients with the shared endpoint', async () => {
  await withModelEnvironment(async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const registry = createModelRegistry({
      fetch: async (input, init) => {
        requests.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') });
        return Response.json({ data: [{ id: 'vendor-flash' }, { id: 'vendor-pro' }] });
      },
    });

    const catalog = await registry.listModels();
    assert.deepEqual(catalog.models.map((model) => model.id), ['vendor-pro', 'vendor-flash']);
    assert.equal(catalog.models[0]?.displayName, 'Vendor Pro');
    assert.deepEqual(requests, [{ url: 'https://vendor.example/v1/models', authorization: 'Bearer secret' }]);
    assert.equal((await registry.assertSelectable('vendor-flash')).model, 'vendor-flash');
    assert.equal(registry.clientFor('vendor-flash').baseUrl, 'https://vendor.example/v1');
    assert.equal(registry.clientFor('vendor-flash').contextWindow, 64_000);
  });
});

test('model registry degrades to the configured default when discovery fails', async () => {
  await withModelEnvironment(async () => {
    const registry = createModelRegistry({ fetch: async () => new Response('', { status: 503 }) });
    const catalog = await registry.listModels();
    assert.deepEqual(catalog.models.map((model) => model.id), ['vendor-pro']);
    assert.match(catalog.warning ?? '', /仅提供默认模型/);
    await assert.rejects(() => registry.assertSelectable('vendor-flash'), /模型不可用/);
  });
});
