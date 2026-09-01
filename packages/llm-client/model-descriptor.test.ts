import assert from 'node:assert/strict';
import test from 'node:test';
import { describeModel } from './model-descriptor.ts';

test('known DeepSeek API models receive their official context window and product name', () => {
  assert.deepEqual(describeModel('deepseek-v4-flash', 'https://api.deepseek.com'), {
    displayName: 'DeepSeek V4 Flash',
    contextWindow: 1_000_000,
    outputTokens: { initial: 16_384, maximum: 384_000 },
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
  });
});

test('unknown compatible models are not assigned an invented context window', () => {
  assert.deepEqual(describeModel('private-deployment', 'https://gateway.example.com/v1'), {
    displayName: 'private-deployment',
    reasoning: { supported: 'unknown', requestMode: 'provider_default' },
  });
});
