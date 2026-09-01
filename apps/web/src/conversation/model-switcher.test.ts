import { describe, expect, it } from 'vitest';
import { previewModelOptions } from './model-switcher';

describe('model switcher preview options', () => {
  it('keeps the actual backend model first without duplicating a preview model', () => {
    expect(previewModelOptions('DeepSeek V4 Pro')).toEqual([
      'DeepSeek V4 Pro',
      'DeepSeek V4 Flash',
      'DeepSeek V4 Flash Vision',
    ]);
  });

  it('includes an unknown backend model alongside the preview choices', () => {
    expect(previewModelOptions('Private Model')).toEqual([
      'Private Model',
      'DeepSeek V4 Flash',
      'DeepSeek V4 Pro',
      'DeepSeek V4 Flash Vision',
    ]);
  });
});
