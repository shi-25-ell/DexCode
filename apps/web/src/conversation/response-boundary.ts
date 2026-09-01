import type { ConversationItem } from '../types';

type ConversationStatus = 'idle' | 'running' | 'waiting' | 'failed';

export type IndexedConversationItem = { item: ConversationItem; index: number };
export type ConversationHistoryGroup =
  | { kind: 'item'; entry: IndexedConversationItem }
  | { kind: 'execution_history'; history: IndexedConversationItem[] }
  | { kind: 'completed_response'; history: IndexedConversationItem[]; final: IndexedConversationItem };

export function isCompleteAssistantResponse(item: ConversationItem, status: ConversationStatus): boolean {
  return item.kind === 'assistant' && item.final === true && status === 'idle';
}

export function groupConversationHistory(items: ConversationItem[]): ConversationHistoryGroup[] {
  const groups: ConversationHistoryGroup[] = [];
  let pending: IndexedConversationItem[] = [];
  const hasFinalBeforeNextUser = (start: number) => {
    for (let index = start + 1; index < items.length; index += 1) {
      const candidate = items[index]!;
      if (candidate.kind === 'assistant' && candidate.final === true) return true;
      if (candidate.kind === 'user' && candidate.delivery !== 'steer') return false;
    }
    return false;
  };
  const flushPending = () => {
    for (const entry of pending) groups.push({ kind: 'item', entry });
    pending = [];
  };

  items.forEach((item, index) => {
    const entry = { item, index };
    if (item.kind === 'user') {
      const completedAfterSteer = item.delivery === 'steer' && hasFinalBeforeNextUser(index);
      if (completedAfterSteer && pending.length > 0) {
        groups.push({ kind: 'execution_history', history: pending });
        pending = [];
      } else flushPending();
      groups.push({ kind: 'item', entry });
      return;
    }
    if (item.kind === 'assistant' && item.final === true) {
      groups.push({ kind: 'completed_response', history: pending, final: entry });
      pending = [];
      return;
    }
    pending.push(entry);
  });
  flushPending();
  return groups;
}

export function assistantResponseCopyText(item: ConversationItem): string {
  return item?.kind === 'assistant' ? item.content : '';
}
