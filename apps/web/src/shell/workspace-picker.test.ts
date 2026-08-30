import { describe, expect, it } from 'vitest';
import { mergeWorkspaceSuggestions } from './workspace-picker';

describe('workspace picker suggestions', () => {
  it('keeps matching recent projects first and de-duplicates filesystem results', () => {
    expect(mergeWorkspaceSuggestions(
      'D:\\Agent',
      ['D:\\AgentDevelop\\DexCode', 'D:\\Other'],
      ['D:\\AgentDevelop\\DexCode', 'D:\\AgentDevelop\\opencode'],
    )).toEqual([
      { path: 'D:\\AgentDevelop\\DexCode', source: 'recent' },
      { path: 'D:\\AgentDevelop\\opencode', source: 'filesystem' },
    ]);
  });

  it('shows all recent projects when the input is empty', () => {
    expect(mergeWorkspaceSuggestions('', ['D:\\One', 'D:\\Two'], [])).toEqual([
      { path: 'D:\\One', source: 'recent' },
      { path: 'D:\\Two', source: 'recent' },
    ]);
  });
});
