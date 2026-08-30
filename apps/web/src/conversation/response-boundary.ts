import type { ConversationItem } from '../types';

type ConversationStatus = 'idle' | 'running' | 'waiting' | 'failed';

export function isCompleteAssistantResponse(items: ConversationItem[], index: number, status: ConversationStatus): boolean {
  if (items[index]?.kind !== 'assistant') return false;
  const next = items[index + 1];
  if (next?.kind === 'user') return true;
  return next === undefined && status === 'idle';
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
