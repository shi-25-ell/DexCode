import type { ConversationItem } from '../types';

type ConversationStatus = 'idle' | 'running' | 'waiting' | 'failed';

export type IndexedConversationItem = { item: ConversationItem; index: number };
export type ConversationHistoryGroup =
  | { kind: 'item'; entry: IndexedConversationItem }
  | { kind: 'completed_response'; history: IndexedConversationItem[]; final: IndexedConversationItem };

export function isCompleteAssistantResponse(item: ConversationItem, status: ConversationStatus): boolean {
  return item.kind === 'assistant' && item.final === true && status === 'idle';
}

export function groupConversationHistory(items: ConversationItem[]): ConversationHistoryGroup[] {
  const groups: ConversationHistoryGroup[] = [];
  let pending: IndexedConversationItem[] = [];
  const flushPending = () => {
    for (const entry of pending) groups.push({ kind: 'item', entry });
    pending = [];
  };

  items.forEach((item, index) => {
    const entry = { item, index };
    if (item.kind === 'user') {
      flushPending();
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
