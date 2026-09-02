import { describe, expect, it } from 'vitest';
import { selectableModelOptions } from './model-switcher';

describe('model switcher options', () => {
  it('shows only models returned by the provider catalog', () => {
    expect(selectableModelOptions([
      { id: 'deepseek-chat', displayName: 'deepseek-chat' },
      { id: 'deepseek-reasoner', displayName: 'deepseek-reasoner' },
    ], 'deepseek-chat').map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('keeps a persisted model visible when it is missing from the current catalog', () => {
    expect(selectableModelOptions([
      { id: 'glm-4.5', displayName: 'glm-4.5' },
    ], 'retired-model')).toEqual([
      { id: 'retired-model', displayName: 'retired-model', available: false },
      { id: 'glm-4.5', displayName: 'glm-4.5', available: true },
    ]);
  });
});
