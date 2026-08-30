import type { ToolPresentation } from '../shared/types.ts';

export type ConversationState = 'idle' | 'running' | 'waiting' | 'failed';

export type ConversationListItem = {
  ref: string;
  title: string;
  preview?: string;
  updatedAt: string;
  state: ConversationState;
  archived: boolean;
};

export type ContextUsageView = {
  usedTokens?: number;
  limitTokens?: number;
  percentage?: number;
  source: 'provider' | 'estimated' | 'unknown';
  asOfTurn?: number;
};

export type ConversationItem =
  | { id: string; kind: 'user'; content: string }
  | { id: string; kind: 'assistant'; content: string }
  | { id: string; kind: 'tool'; tool: ToolPresentation }
  | { id: string; kind: 'error'; title: string; message: string };

export type ConversationViewSnapshot = {
  ref: string;
  title: string;
  state: ConversationState;
  updatedAt: string;
  items: ConversationItem[];
  contextUsage: ContextUsageView;
};

export type ModelDisplayDescriptor = {
  displayName: string;
  contextWindow?: number;
  providerDisplayName?: string;
};
