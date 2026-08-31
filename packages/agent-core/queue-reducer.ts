import type { QueueItemView, QueueLedgerRecord, SessionLedgerRecord } from '../shared/types.ts';

export type QueueProjection = {
  items: QueueItemView[];
  pending: QueueItemView[];
  paused: boolean;
};

function isQueueRecord(record: SessionLedgerRecord): record is QueueLedgerRecord {
  return record.type.startsWith('queue_');
}

export function projectQueue(sessionId: string, records: SessionLedgerRecord[]): QueueProjection {
  const items = new Map<string, QueueItemView>();
  let paused = false;
  for (const record of records) {
    if (!isQueueRecord(record)) continue;
    if (record.type === 'queue_enqueued') {
      if (items.has(record.itemId)) throw new Error(`Duplicate Queue item: ${record.itemId}`);
      items.set(record.itemId, {
        itemId: record.itemId,
        sessionId,
        content: record.message.content,
        delivery: record.delivery,
        status: 'queued',
        ...(record.targetRunId ? { targetRunId: record.targetRunId } : {}),
        createdAt: record.at,
        updatedAt: record.at,
        position: record.position,
        revision: record.sessionRevision,
      });
      continue;
    }
    if (record.type === 'queue_chain_paused') {
      paused = true;
      continue;
    }
    if (record.type === 'queue_chain_resumed') {
      paused = false;
      continue;
    }
    if (record.type === 'queue_reordered') {
      const pendingIds = [...items.values()].filter((item) => item.status === 'queued').map((item) => item.itemId);
      if (record.orderedItemIds.length !== pendingIds.length || new Set(record.orderedItemIds).size !== pendingIds.length || record.orderedItemIds.some((id) => !pendingIds.includes(id))) {
        throw new Error('Queue reorder record does not contain every pending item exactly once');
      }
      record.orderedItemIds.forEach((itemId, position) => {
        const item = items.get(itemId)!;
        items.set(itemId, { ...item, position, updatedAt: record.at, revision: record.sessionRevision });
      });
      continue;
    }
    const item = items.get(record.itemId);
    if (!item) throw new Error(`Queue record references missing item: ${record.itemId}`);
    if (record.type === 'queue_retargeted') {
      if (item.status !== 'queued' || item.delivery !== 'next_run') throw new Error(`Queue item cannot be retargeted: ${record.itemId}`);
      items.set(record.itemId, { ...item, delivery: 'steer', targetRunId: record.targetRunId, updatedAt: record.at, revision: record.sessionRevision });
    } else if (record.type === 'queue_requeued') {
      if (item.status !== 'queued' || item.delivery !== 'steer' || item.targetRunId !== record.fromRunId) throw new Error(`Queue item cannot be requeued: ${record.itemId}`);
      const { targetRunId: _targetRunId, ...rest } = item;
      items.set(record.itemId, { ...rest, delivery: 'next_run', updatedAt: record.at, revision: record.sessionRevision });
    } else if (record.type === 'queue_consumed') {
      if (item.status !== 'queued' || item.delivery !== record.delivery) throw new Error(`Queue item cannot be consumed: ${record.itemId}`);
      items.set(record.itemId, { ...item, status: 'consumed', consumedRunId: record.runId, updatedAt: record.at, revision: record.sessionRevision });
    } else if (record.type === 'queue_cancelled') {
      if (item.status !== 'queued') throw new Error(`Queue item cannot be cancelled: ${record.itemId}`);
      items.set(record.itemId, { ...item, status: 'cancelled', updatedAt: record.at, revision: record.sessionRevision });
    }
  }
  const all = [...items.values()].sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
  return { items: all, pending: all.filter((item) => item.status === 'queued'), paused };
}

export function findQueueOperation(records: SessionLedgerRecord[], operationId: string): QueueLedgerRecord | undefined {
  return records.find((record): record is QueueLedgerRecord => isQueueRecord(record) && record.operationId === operationId);
}
