import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session, ToolApprovalRequest, ToolPresentation, ToolViewStatus } from '../shared/types.ts';
import { projectConversation } from './projection.ts';
import { batchToolSequence, toolBatchStatus, toolBatchSummary } from './tool-batching.ts';
import { presentTool } from './tool-presentation.ts';

function tool(toolName: string, callRef: string, status: ToolViewStatus = 'succeeded', path = `${callRef}.ts`): ToolPresentation {
  const failed = status === 'failed';
  return presentTool({
    callRef,
    tool: toolName,
    args: toolName === 'grep' ? { pattern: callRef, path: 'src' } : toolName === 'run_command' ? { command: callRef } : { path },
    result: failed ? { error: `error-${callRef}` } : { ok: true, content: 'one\ntwo' },
    status,
    ...(toolName === 'write_file' || toolName === 'patch_file' ? { fileDiff: { path, before: 'old', after: 'new' } } : {}),
  });
}

function sequence(tools: ToolPresentation[]) {
  return batchToolSequence(tools.map((value) => ({ kind: 'tool' as const, key: value.callRef, tool: value })));
}

test('large consecutive inspection and modification runs stay in one stable batch', () => {
  const reads = sequence(Array.from({ length: 25 }, (_, index) => tool(index % 5 === 0 ? 'grep' : 'read_file', `read-${index}`)));
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.kind, 'tool_batch');
  if (reads[0]?.kind === 'tool_batch') {
    assert.equal(reads[0].batch.id, 'tool-batch-inspection-read-0');
    assert.equal(reads[0].batch.members.length, 25);
    assert.equal(toolBatchSummary(reads[0].batch), '检查了 20 个文件 · 搜索 5 次 · 25 项操作');
  }

  const writes = sequence(Array.from({ length: 15 }, (_, index) => tool(index % 2 ? 'patch_file' : 'write_file', `write-${index}`, 'succeeded', index < 2 ? 'same.ts' : `file-${index}.ts`)));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.kind, 'tool_batch');
  if (writes[0]?.kind === 'tool_batch') {
    assert.equal(writes[0].batch.members.length, 15);
    assert.deepEqual(writes[0].batch.members.slice(0, 2).map((member) => member.fileChange?.path), ['same.ts', 'same.ts']);
    assert.match(toolBatchSummary(writes[0].batch), /^修改 14 个文件 · 15 次操作/);
  }
});

test('type changes, assistant boundaries, other tools and context-like boundaries end batches', () => {
  const read1 = tool('read_file', 'read-1');
  const write1 = tool('write_file', 'write-1');
  const read2 = tool('read_file', 'read-2');
  const command = tool('run_command', 'command-1');
  const output = batchToolSequence([
    { kind: 'tool', key: 'read-1', tool: read1 },
    { kind: 'tool', key: 'write-1', tool: write1 },
    { kind: 'boundary', key: 'assistant-empty', value: 'assistant-empty' },
    { kind: 'tool', key: 'read-2', tool: read2 },
    { kind: 'boundary', key: 'assistant-visible', value: 'assistant-visible' },
    { kind: 'tool', key: 'command-1', tool: command },
    { kind: 'boundary', key: 'context', value: 'context' },
    { kind: 'tool', key: 'read-3', tool: tool('read_file', 'read-3') },
  ]);
  assert.deepEqual(output.map((entry) => entry.kind === 'tool_batch' ? `${entry.kind}:${entry.batch.type}:${entry.batch.members.length}` : `${entry.kind}:${entry.key}`), [
    'tool_batch:inspection:1',
    'tool_batch:modification:1',
    'boundary:assistant-empty',
    'tool_batch:inspection:1',
    'boundary:assistant-visible',
    'tool_batch:command:1',
    'boundary:context',
    'tool_batch:inspection:1',
  ]);
});

test('consecutive commands merge across their individual approval cards', () => {
  const first = tool('run_command', 'command-1');
  const second = tool('run_command', 'command-2', 'failed');
  const output = batchToolSequence([
    { kind: 'tool', key: first.callRef, tool: first },
    { kind: 'boundary', key: 'approval-1', value: 'approval-1', transparentFor: ['command'] },
    { kind: 'tool', key: second.callRef, tool: second },
    { kind: 'boundary', key: 'approval-2', value: 'approval-2', transparentFor: ['command'] },
  ]);
  assert.equal(output[0]?.kind, 'tool_batch');
  if (output[0]?.kind === 'tool_batch') {
    assert.equal(output[0].batch.id, 'tool-batch-command-command-1');
    assert.deepEqual(output[0].batch.members.map((member) => member.callRef), ['command-1', 'command-2']);
    assert.equal(toolBatchSummary(output[0].batch), '执行了 2 个命令操作 · 异常 1 个');
    assert.deepEqual(toolBatchStatus(output[0].batch), { status: 'warning', failed: 1 });
  }
  assert.deepEqual(output.slice(1).map((entry) => entry.key), ['approval-1', 'approval-2']);
});

test('batch status exposes partial and total failures without changing membership', () => {
  const partial = { id: 'partial', type: 'inspection' as const, members: [tool('read_file', 'ok'), tool('read_file', 'bad', 'failed')] };
  assert.deepEqual(toolBatchStatus(partial), { status: 'warning', failed: 1 });
  assert.deepEqual(partial.members.map((member) => member.callRef), ['ok', 'bad']);
  assert.deepEqual(toolBatchStatus({ ...partial, members: [tool('read_file', 'bad-1', 'failed'), tool('read_file', 'bad-2', 'failed')] }), { status: 'failed', failed: 2 });
  assert.deepEqual(toolBatchStatus({ ...partial, members: [tool('read_file', 'invalid-1', 'invalid'), tool('read_file', 'invalid-2', 'invalid')] }), { status: 'invalid', failed: 2 });
  assert.deepEqual(toolBatchStatus({ ...partial, members: [tool('read_file', 'blocked-1', 'blocked')] }), { status: 'blocked', failed: 1 });
  assert.deepEqual(toolBatchStatus({ ...partial, members: [tool('read_file', 'bad', 'failed'), tool('read_file', 'live', 'running')] }), { status: 'running', failed: 1 });
  assert.deepEqual(toolBatchStatus({ ...partial, members: [tool('read_file', 'deny-1', 'denied'), tool('read_file', 'deny-2', 'denied')] }), { status: 'denied', failed: 0 });
  assert.deepEqual(toolBatchStatus({ ...partial, members: [tool('read_file', 'deny', 'denied'), tool('read_file', 'cancel', 'cancelled')] }), { status: 'denied', failed: 0 });
  assert.deepEqual(toolBatchStatus({ ...partial, members: [tool('read_file', 'cancel-1', 'cancelled')] }), { status: 'cancelled', failed: 0 });
});

test('history ends a batch when the Run changes and never projects completion records alone', () => {
  const now = '2026-09-01T00:00:00.000Z';
  const first = tool('read_file', 'run-one-call');
  const second = tool('read_file', 'run-two-call');
  const session: Session = {
    sessionId: 'session-run-boundary', scope: { kind: 'general' }, createdAt: now, updatedAt: now,
    messages: [], taskSummaries: [], activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId: 'run-1', type: 'tool_started', callId: first.callRef, tool: first.toolName },
      { seq: 2, at: now, runId: 'run-1', type: 'tool_completed', callId: first.callRef, presentation: first },
      { seq: 3, at: now, runId: 'run-2', type: 'tool_started', callId: second.callRef, tool: second.toolName },
      { seq: 4, at: now, runId: 'run-2', type: 'tool_completed', callId: second.callRef, presentation: second },
      { seq: 5, at: now, runId: 'run-2', type: 'tool_completed', callId: 'completion-only', presentation: tool('read_file', 'completion-only') },
    ],
  };
  const batches = projectConversation(session).items.filter((item) => item.kind === 'tool_batch');
  assert.deepEqual(batches.map((item) => item.kind === 'tool_batch' ? item.batch.members.map((member) => member.callRef) : []), [['run-one-call'], ['run-two-call']]);
});

test('history keeps command approvals separate while annotating the merged command batch', () => {
  const now = '2026-09-01T00:00:00.000Z';
  const first = tool('run_command', 'command-one');
  const second = tool('run_command', 'command-two', 'denied');
  const request = (approvalId: string, target: string): ToolApprovalRequest => ({
    version: 1 as const, approvalId, toolName: 'run_command', effect: 'execute' as const,
    title: `批准 ${target}`, target, reason: '需要批准', fingerprint: approvalId,
    options: ['allow_once', 'allow_whitelist', 'deny'],
  });
  const session: Session = {
    sessionId: 'session-command-history', scope: { kind: 'general' }, createdAt: now, updatedAt: now,
    messages: [], taskSummaries: [], activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId: 'run-1', type: 'tool_started', callId: first.callRef, tool: 'run_command', input: { command: 'npm test' } },
      { seq: 2, at: now, runId: 'run-1', type: 'approval_requested', approvalId: 'approval-1', request: request('approval-1', 'npm test') },
      { seq: 3, at: now, runId: 'run-1', type: 'approval_resolved', approvalId: 'approval-1', decision: 'allow_whitelist' },
      { seq: 4, at: now, runId: 'run-1', type: 'tool_completed', callId: first.callRef, presentation: first },
      { seq: 5, at: now, runId: 'run-1', type: 'tool_started', callId: second.callRef, tool: 'run_command', input: { command: 'npm run lint' } },
      { seq: 6, at: now, runId: 'run-1', type: 'approval_requested', approvalId: 'approval-2', request: request('approval-2', 'npm run lint') },
      { seq: 7, at: now, runId: 'run-1', type: 'approval_resolved', approvalId: 'approval-2', decision: 'deny' },
      { seq: 8, at: now, runId: 'run-1', type: 'tool_completed', callId: second.callRef, presentation: second },
    ],
  };
  const items = projectConversation(session).items;
  assert.deepEqual(items.map((item) => item.kind), ['tool_batch', 'approval', 'approval']);
  const batch = items[0];
  if (batch?.kind === 'tool_batch') assert.deepEqual(batch.batch.members.map((member) => member.approval), [
    { status: 'approved', addedToWhitelist: true },
    { status: 'denied', addedToWhitelist: false },
  ]);
});

test('history uses start order, ignores completion order, and matches live batching', () => {
  const now = '2026-09-01T00:00:00.000Z';
  const first = tool('read_file', 'call-first');
  const second = tool('grep', 'call-second');
  const third = tool('read_file', 'call-third');
  const fourth = tool('read_file', 'call-fourth');
  const session: Session = {
    sessionId: 'session-batches', scope: { kind: 'general' }, createdAt: now, updatedAt: now,
    messages: [], taskSummaries: [], activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId: 'run-1', type: 'tool_started', callId: 'call-first', tool: 'read_file', input: { path: 'first.ts' } },
      { seq: 2, at: now, runId: 'run-1', type: 'tool_started', callId: 'call-second', tool: 'grep', input: { pattern: 'x' } },
      { seq: 3, at: now, runId: 'run-1', type: 'tool_completed', callId: 'call-second', presentation: second },
      { seq: 4, at: now, runId: 'run-1', type: 'tool_completed', callId: 'call-first', presentation: first },
      { seq: 5, at: now, runId: 'run-1', type: 'message', message: { role: 'assistant', content: null } },
      { seq: 6, at: now, runId: 'run-1', type: 'tool_started', callId: 'call-third', tool: 'read_file', input: { path: 'third.ts' } },
      { seq: 7, at: now, runId: 'run-1', type: 'tool_completed', callId: 'call-third', presentation: third },
      { seq: 8, at: now, runId: 'run-1', type: 'message', message: { role: 'assistant', content: '可见说明' } },
      { seq: 9, at: now, runId: 'run-1', type: 'tool_started', callId: 'call-fourth', tool: 'read_file', input: { path: 'fourth.ts' } },
      { seq: 10, at: now, runId: 'run-1', type: 'tool_completed', callId: 'call-fourth', presentation: fourth },
    ],
  };
  const history = projectConversation(session).items.filter((item) => item.kind === 'tool_batch');
  assert.deepEqual(history.map((item) => item.kind === 'tool_batch' ? item.batch.members.map((member) => member.callRef) : []), [['call-first', 'call-second'], ['call-third'], ['call-fourth']]);

  const live = batchToolSequence([
    { kind: 'tool', key: 'call-first', tool: first },
    { kind: 'tool', key: 'call-second', tool: second },
    { kind: 'boundary', key: 'assistant-empty', value: null },
    { kind: 'tool', key: 'call-third', tool: third },
    { kind: 'boundary', key: 'assistant-visible', value: '可见说明' },
    { kind: 'tool', key: 'call-fourth', tool: fourth },
  ]).filter((item) => item.kind === 'tool_batch');
  assert.deepEqual(
    history.map((item) => item.kind === 'tool_batch' ? [item.batch.id, ...item.batch.members.map((member) => member.callRef)] : []),
    live.map((item) => item.kind === 'tool_batch' ? [item.batch.id, ...item.batch.members.map((member) => member.callRef)] : []),
  );
});
