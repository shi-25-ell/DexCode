import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionLedgerRecord } from '../shared/types.ts';
import { projectQueue } from './queue-reducer.ts';

test('Queue reducer projects enqueue, retarget, consume and pause without entering conversation history', () => {
  const at = '2026-08-31T00:00:00.000Z';
  const records: SessionLedgerRecord[] = [
    { seq: 1, at, type: 'queue_enqueued', operationId: 'op-1', itemId: 'queue-1', message: { role: 'user', content: 'first' }, delivery: 'next_run', position: 0, sessionRevision: 1 },
    { seq: 2, at, type: 'queue_enqueued', operationId: 'op-2', itemId: 'queue-2', message: { role: 'user', content: 'second' }, delivery: 'next_run', position: 1, sessionRevision: 2 },
    { seq: 3, at, type: 'queue_retargeted', operationId: 'op-3', itemId: 'queue-1', from: 'next_run', to: 'steer', targetRunId: 'run-1', sessionRevision: 3 },
    { seq: 4, at, type: 'queue_consumed', operationId: 'op-4', itemId: 'queue-1', delivery: 'steer', runId: 'run-1', sessionRevision: 4 },
    { seq: 5, at, type: 'queue_chain_paused', operationId: 'op-5', reason: 'user_stop', sessionRevision: 5 },
  ];
  const result = projectQueue('session-1', records);
  assert.equal(result.paused, true);
  assert.deepEqual(result.pending.map((item) => item.itemId), ['queue-2']);
  assert.equal(result.items[0]?.status, 'consumed');
  assert.equal(result.items[0]?.consumedRunId, 'run-1');
});

test('Queue reducer applies full-order reordering and rejects malformed records', () => {
  const at = '2026-08-31T00:00:00.000Z';
  const base: SessionLedgerRecord[] = [
    { seq: 1, at, type: 'queue_enqueued', operationId: 'op-1', itemId: 'queue-1', message: { role: 'user', content: 'first' }, delivery: 'next_run', position: 0, sessionRevision: 1 },
    { seq: 2, at, type: 'queue_enqueued', operationId: 'op-2', itemId: 'queue-2', message: { role: 'user', content: 'second' }, delivery: 'next_run', position: 1, sessionRevision: 2 },
  ];
  assert.deepEqual(projectQueue('session-1', [...base, { seq: 3, at, type: 'queue_reordered', operationId: 'op-3', orderedItemIds: ['queue-2', 'queue-1'], sessionRevision: 3 }]).pending.map((item) => item.itemId), ['queue-2', 'queue-1']);
  assert.throws(() => projectQueue('session-1', [...base, { seq: 3, at, type: 'queue_reordered', operationId: 'op-3', orderedItemIds: ['queue-1'], sessionRevision: 3 }]), /every pending item/);
});
