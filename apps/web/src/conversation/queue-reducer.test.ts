import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../types';
import { initialQueueState, queueReducer } from './queue-reducer';

const item = (itemId: string, revision: number): QueueItem => ({
  itemId,
  sessionId: 'session-1',
  content: itemId,
  delivery: 'next_run',
  status: 'queued',
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
  position: 0,
  revision,
});

describe('queueReducer', () => {
  it('rejects stale semantic events after a newer snapshot', () => {
    const state = queueReducer(initialQueueState, { type: 'queue_snapshot', items: [item('new', 5)], revision: 5, paused: false });
    expect(queueReducer(state, { type: 'queue_upsert', item: item('stale', 4), revision: 4 })).toBe(state);
  });

  it('removes consumed items and tracks the active chained Run', () => {
    let state = queueReducer(initialQueueState, { type: 'queue_snapshot', items: [item('queue-1', 1)], revision: 1, paused: true });
    state = queueReducer(state, { type: 'run_started', runId: 'run-2', sourceItemId: 'queue-1' });
    expect(state.items).toEqual([]);
    expect(state.activeRunId).toBe('run-2');
    expect(state.paused).toBe(false);
  });
});
