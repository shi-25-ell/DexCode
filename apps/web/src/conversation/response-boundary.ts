import type { ConversationItem } from '../types';

type ConversationStatus = 'idle' | 'running' | 'waiting' | 'failed';

export function isCompleteAssistantResponse(item: ConversationItem, status: ConversationStatus): boolean {
  return item.kind === 'assistant' && item.final === true && status === 'idle';
}

export function assistantResponseCopyText(items: ConversationItem[], index: number): string {
  const parts: string[] = [];
  for (let cursor = index; cursor >= 0; cursor--) {
    const item = items[cursor];
    if (item.kind === 'user') break;
    if (item.kind === 'assistant') parts.unshift(item.content);
  }
  return parts.join('\n\n');
}
