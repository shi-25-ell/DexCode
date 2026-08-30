import type { ContextBreakdown, ContextPresentation, ContextUsageSource, ContextUsageTiming, ToolPresentation } from '../shared/types.ts';

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
  contextWindowTokens?: number;
  hardLimitTokens?: number;
  targetTokens?: number;
  percentage?: number;
  source: ContextUsageSource;
  timing: ContextUsageTiming;
  asOfTurn?: number;
  asOfAttempt?: number;
  breakdown?: ContextBreakdown;
  breakdownEstimated?: boolean;
};

export type ConversationItem =
  | { id: string; kind: 'user'; content: string }
  | { id: string; kind: 'assistant'; content: string }
  | { id: string; kind: 'tool'; tool: ToolPresentation }
  | { id: string; kind: 'context'; context: ContextPresentation }
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
