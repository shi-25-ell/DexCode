import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunEventEnvelope, RunEventPayload } from './contracts.ts';
import { runEventToLegacy } from './legacy-adapter.ts';
import { coalesceRunEvents, isDroppableRunEvent, RunEventSequenceValidator, safeRunNote } from './validation.ts';

const runId = 'run-contract';
const at = '2026-08-31T00:00:00.000Z';
function event(seq: number, payload: RunEventPayload): RunEventEnvelope {
  return { version: 2, runId, seq, at, event: payload };
}

const emptyConversation = {
  ref: 'session-contract',
  title: 'Contract',
  state: 'idle' as const,
  updatedAt: at,
  revision: 7,
  queuedItems: [],
  queuePaused: false,
  items: [],
  contextUsage: { source: 'unknown' as const, timing: 'next_request' as const },
};

test('RunEvent V2 validates stable message, tool and terminal lifecycles', () => {
  const validator = new RunEventSequenceValidator(runId);
  const sequence = [
    event(1, { type: 'run_started', sessionId: 'session-contract' }),
    event(2, { type: 'assistant_message_started', turn: 1, messageId: 'run-contract:turn:1' }),
    event(3, { type: 'assistant_content_delta', messageId: 'run-contract:turn:1', contentIndex: 1, kind: 'text', delta: 'answer' }),
    event(4, {
      type: 'assistant_message_committed',
      turn: 1,
      message: {
        messageId: 'run-contract:turn:1',
        turn: 1,
        content: '',
        contentBlocks: [],
        toolCalls: [{ contentIndex: 2, callId: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
        finishReason: 'tool_calls',
      },
    }),
    event(5, { type: 'tool_started', callId: 'call-1', presentation: { callRef: 'call-1', category: 'read', name: '读取文件', status: 'queued', summary: '准备执行' } }),
    event(6, { type: 'tool_progress', callId: 'call-1', presentation: { callRef: 'call-1', category: 'read', name: '读取文件', status: 'running', summary: '正在执行' } }),
    event(7, { type: 'tool_finished', callId: 'call-1', presentation: { callRef: 'call-1', category: 'read', name: '读取文件', status: 'succeeded', summary: '完成' } }),
    event(8, { type: 'run_finished', terminal: { status: 'completed', reason: 'natural_completion' }, conversationRevision: 7, conversation: emptyConversation }),
  ];
  for (const item of sequence) assert.equal(validator.accept(item), 'accepted');
  assert.equal(validator.accept(sequence.at(-1)!), 'duplicate');
  assert.throws(() => validator.accept(event(9, { type: 'run_phase_changed', phase: 'answering' })), /after terminal/);
});

test('RunEvent V2 detects gaps, unknown drafts and invalid tool progress', () => {
  const gap = new RunEventSequenceValidator(runId);
  gap.accept(event(1, { type: 'run_started', sessionId: 'session-contract' }));
  assert.throws(() => gap.accept(event(3, { type: 'run_phase_changed', phase: 'thinking' })), /seq gap/);

  const draft = new RunEventSequenceValidator(runId);
  draft.accept(event(1, { type: 'run_started', sessionId: 'session-contract' }));
  assert.throws(() => draft.accept(event(2, { type: 'assistant_content_delta', messageId: 'missing', contentIndex: 0, kind: 'reasoning', delta: 'x' })), /inactive message/);

  const tool = new RunEventSequenceValidator(runId);
  tool.accept(event(1, { type: 'run_started', sessionId: 'session-contract' }));
  assert.throws(() => tool.accept(event(2, { type: 'tool_progress', callId: 'missing', presentation: { callRef: 'missing', category: 'other', name: '工具', status: 'running', summary: 'x' } })), /inactive call/);

  const crossedTool = new RunEventSequenceValidator(runId);
  crossedTool.accept(event(1, { type: 'run_started', sessionId: 'session-contract' }));
  assert.throws(() => crossedTool.accept(event(2, { type: 'tool_started', callId: 'call-1', presentation: { callRef: 'call-2', category: 'other', name: '工具', status: 'queued', summary: 'x' } })), /crossed callId/);
});

test('only recoverable deltas and progress are droppable and compatible deltas coalesce', () => {
  const first = event(2, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 1, kind: 'text', delta: 'hel' });
  const second = event(3, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 1, kind: 'text', delta: 'lo' });
  assert.equal(isDroppableRunEvent(first), true);
  assert.equal(isDroppableRunEvent(event(4, { type: 'assistant_message_started', turn: 1, messageId: 'message-1' })), false);
  assert.equal(isDroppableRunEvent(event(5, { type: 'run_finished', terminal: { status: 'completed', reason: 'done' }, conversationRevision: 7, conversation: emptyConversation })), false);
  assert.equal((coalesceRunEvents(first, second)?.event as { delta?: string }).delta, 'hello');
  assert.equal(coalesceRunEvents(first, event(3, { type: 'assistant_content_delta', messageId: 'other', contentIndex: 1, kind: 'text', delta: 'lo' })), undefined);
});

test('safe notes remove secrets and host paths before presentation', () => {
  const note = safeRunNote('retry D:\\private\\repo Authorization: Bearer secret-token');
  assert.doesNotMatch(note ?? '', /private|secret-token/);
  assert.match(note ?? '', /已隐藏/);
});

test('legacy adapter preserves text, tool terminal and final conversation meaning', () => {
  assert.deepEqual(runEventToLegacy(event(2, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 1, kind: 'text', delta: 'answer' })), [{ type: 'chunk', chunk: 'answer' }]);
  const tool = { callRef: 'call-1', category: 'read' as const, name: '读取文件', status: 'succeeded' as const, summary: '完成' };
  assert.deepEqual(runEventToLegacy(event(3, { type: 'tool_finished', callId: 'call-1', presentation: tool })).at(-1), { type: 'tool_view', presentation: tool });
  const terminal = runEventToLegacy(event(4, { type: 'run_finished', terminal: { status: 'completed', reason: 'natural_completion' }, conversationRevision: 7, finalMessageId: 'message-1', conversation: emptyConversation }));
  assert.equal(terminal.at(-1)?.type, 'result');
  assert.match(JSON.stringify(terminal), /session-contract/);
});
