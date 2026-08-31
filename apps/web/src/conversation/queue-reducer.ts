import type { QueueItem } from '../types';

export type QueueState = {
  items: QueueItem[];
  revision: number;
  paused: boolean;
  activeRunId?: string;
};

export type QueueAction =
  | { type: 'session_reset' }
  | { type: 'queue_snapshot'; items: QueueItem[]; revision: number; paused: boolean; activeRunId?: string }
  | { type: 'queue_upsert'; item: QueueItem; revision: number }
  | { type: 'queue_remove'; itemId: string; revision: number }
  | { type: 'queue_reorder'; orderedItemIds: string[]; revision: number }
  | { type: 'run_started'; runId: string; sourceItemId?: string }
  | { type: 'run_chain_paused' }
  | { type: 'run_terminal' };

export const initialQueueState: QueueState = { items: [], revision: 0, paused: false };

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  if (action.type === 'session_reset') return initialQueueState;
  if ('revision' in action && action.revision < state.revision) return state;
  if (action.type === 'queue_snapshot') {
    return { items: action.items.filter((item) => item.status === 'queued'), revision: action.revision, paused: action.paused, ...(action.activeRunId ? { activeRunId: action.activeRunId } : {}) };
  }
  if (action.type === 'queue_upsert') {
    const items = state.items.filter((item) => item.itemId !== action.item.itemId);
    if (action.item.status === 'queued') items.push(action.item);
    items.sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
    return { ...state, items, revision: action.revision };
  }
  if (action.type === 'queue_remove') return { ...state, items: state.items.filter((item) => item.itemId !== action.itemId), revision: action.revision };
  if (action.type === 'queue_reorder') {
    const byId = new Map(state.items.map((item) => [item.itemId, item]));
    return { ...state, revision: action.revision, items: action.orderedItemIds.flatMap((id, position) => {
      const item = byId.get(id);
      return item ? [{ ...item, position }] : [];
    }) };
  }
  if (action.type === 'run_started') return { ...state, paused: false, activeRunId: action.runId, items: action.sourceItemId ? state.items.filter((item) => item.itemId !== action.sourceItemId) : state.items };
  if (action.type === 'run_chain_paused') return { ...state, paused: true, activeRunId: undefined };
  return { ...state, activeRunId: undefined };
}
