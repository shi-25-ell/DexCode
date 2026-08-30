import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import type { ChatOptions, ModelClient, ModelEvent } from '../llm-client/index.ts';
import { createSessionRepository } from '../session-store/index.ts';
import type { AgentEvent, ChatMessage } from '../shared/types.ts';
import { createCodingAgent } from './index.ts';

function toolHost() {
  return {
    readFile: () => ({ content: '' }),
    writeFile: () => ({ ok: true }),
    runCommand: () => ({ ok: true }),
    listWorkspace: () => [],
    searchInWorkspace: () => [],
    patchFile: () => ({ ok: true }),
    listVersions: () => [],
    createSnapshot: () => ({ ok: true }),
    restoreSnapshot: () => ({ ok: true }),
  };
}

function completingModel(observed: Array<{ messages: ChatMessage[]; options?: ChatOptions }>): ModelClient {
  return {
    model: 'strategy-test',
    baseUrl: 'memory://strategy-test',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    async *streamMessage(messages, options): AsyncIterable<ModelEvent> {
      observed.push({ messages: structuredClone(messages) as ChatMessage[], options });
      yield { version: 1, type: 'turn_started', attemptId: 'attempt-1' };
      yield { version: 1, type: 'text_delta', delta: 'done' };
      yield {
        version: 1,
        type: 'turn_completed',
        response: {
          content: 'done',
          reasoning: '',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 120, outputTokens: 4, totalTokens: 124 },
        },
      };
    },
  };
}

test('backend strategy selects the legacy or four-layer request path and records the choice', async () => {
  const previousStrategy = process.env.CONTEXT_COMPACTION_STRATEGY;
  const previousEnabled = process.env.CONTEXT_COMPACTION_ENABLED;
  const projectDirs: string[] = [];
  try {
    for (const strategy of ['legacy', 'four_layer'] as const) {
      process.env.CONTEXT_COMPACTION_STRATEGY = strategy;
      process.env.CONTEXT_COMPACTION_ENABLED = 'true';
      const repository = createSessionRepository({ projectId: `test-strategy-${strategy}-${crypto.randomUUID()}` });
      projectDirs.push(dirname(repository.sessionsDir));
      const session = await repository.createSession();
      await repository.appendMessages(session.sessionId, [
        { role: 'user', content: 'previous request' },
        { role: 'assistant', content: 'previous answer' },
      ]);
      const observed: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
      const agent = createCodingAgent(
        { buildForPrompt: async (prompt) => ({ prompt, selectedFile: null, selectedFileContent: null, workspaceSummary: '', contextBudget: { includedFiles: [], maxChars: 0, maxFiles: 0 } }) },
        toolHost(),
        completingModel(observed),
        repository,
        undefined,
        undefined,
        { scope: { kind: 'general' } },
      );

      const events: AgentEvent[] = [];
      await agent.runTask(session.sessionId, 'current request', null, (event) => events.push(event), async () => 'confirm');

      const loaded = await repository.loadSession(session.sessionId);
      assert.equal(loaded?.runReports?.at(-1)?.contextStrategy, strategy);
      assert.equal(loaded?.contextManifests?.at(-1)?.version, strategy === 'legacy' ? 1 : 2);
      assert.equal(observed.length, 1);
      assert.equal(observed[0]?.messages[0]?.role, 'system');
      assert.equal(observed[0]?.messages.at(-1)?.role, 'user');
      assert.equal(observed[0]?.messages.at(-1)?.content, 'current request');
      const tools = observed[0]?.options?.tools as Array<{ function?: { name?: string } }> | undefined;
      assert.equal(tools?.some((tool) => tool.function?.name === 'compact_context') ?? false, strategy === 'four_layer');
      assert.equal(tools?.some((tool) => tool.function?.name === 'read_artifact') ?? false, strategy === 'four_layer');
      assert.equal(events.some((event) => event.type === 'context_usage' && event.source === 'provider' && event.usedTokens === 120), true);
      if (strategy === 'legacy') assert.equal(events.some((event) => event.type === 'context_activity'), false);
    }
  } finally {
    if (previousStrategy === undefined) delete process.env.CONTEXT_COMPACTION_STRATEGY;
    else process.env.CONTEXT_COMPACTION_STRATEGY = previousStrategy;
    if (previousEnabled === undefined) delete process.env.CONTEXT_COMPACTION_ENABLED;
    else process.env.CONTEXT_COMPACTION_ENABLED = previousEnabled;
    await Promise.all(projectDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  }
});
