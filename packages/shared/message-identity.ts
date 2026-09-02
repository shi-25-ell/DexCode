import type { ChatMessage } from './types.ts';

// Identity metadata is process-local and never serialized to a provider or journal.
const identities = new WeakMap<ChatMessage, string>();

export function identifyMessage<T extends ChatMessage>(message: T, id: string): T {
  identities.set(message, id);
  return message;
}

export function messageIdentity(message: ChatMessage): string | undefined {
  return identities.get(message);
}

export function copyMessageIdentities(source: ChatMessage[], target: ChatMessage[]): void {
  source.forEach((message, index) => {
    const id = identities.get(message);
    const copy = target[index];
    if (id && copy) identities.set(copy, id);
  });
}

export function cloneMessagesWithIdentity(messages: ChatMessage[]): ChatMessage[] {
  const copy = structuredClone(messages);
  copyMessageIdentities(messages, copy);
  return copy;
}
