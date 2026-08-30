import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../shared/types.ts';
import { contextCompactionStrategy, projectLegacyHistory } from './context-strategy.ts';

test('context strategy defaults to four_layer and accepts an explicit legacy mode', () => {
  assert.equal(contextCompactionStrategy({}), 'four_layer');
  assert.equal(contextCompactionStrategy({ CONTEXT_COMPACTION_STRATEGY: ' legacy ' }), 'legacy');
  assert.equal(contextCompactionStrategy({ CONTEXT_COMPACTION_STRATEGY: 'FOUR_LAYER' }), 'four_layer');
  assert.throws(
    () => contextCompactionStrategy({ CONTEXT_COMPACTION_STRATEGY: 'disabled' }),
    /must be four_layer or legacy/,
  );
});

test('legacy projection keeps paired history unchanged below its limit', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'inspect' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'read-1', name: 'read_file', content: 'result' },
    { role: 'tool', tool_call_id: 'orphan', name: 'read_file', content: 'must not be sent' },
  ];

  const projection = projectLegacyHistory('run-small', messages, 1_000);

  assert.equal(projection.checkpoint, undefined);
  assert.deepEqual(projection.messages, messages.slice(0, 3));
  assert.equal(projection.manifest.omittedMessageCount, 0);
  assert.equal(projection.manifest.selectedMessageCount, 3);
});

test('legacy projection creates a deterministic preview and retains history from a user turn', () => {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < 8; index += 1) {
    messages.push(
      { role: 'user', content: `request-${index}-${'u'.repeat(350)}` },
      { role: 'assistant', content: `answer-${index}-${'a'.repeat(350)}` },
    );
  }

  const projection = projectLegacyHistory('run-large', messages, 500);

  assert.ok(projection.checkpoint);
  assert.equal(projection.checkpoint?.strategyVersion, 'deterministic-summary-v1');
  assert.equal(projection.messages[0]?.role, 'system');
  assert.match(projection.messages[0]?.content ?? '', /Previous conversation checkpoint/);
  assert.equal(projection.messages[1]?.role, 'user');
  assert.ok(projection.manifest.omittedMessageCount > 0);
  assert.equal(projection.manifest.checkpointId, projection.checkpoint?.id);
  assert.equal(projection.checkpoint?.sourceMessageCount, projection.manifest.omittedMessageCount);
});
