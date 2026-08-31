import type { ApprovalEffect, ApprovalOption, ContextBreakdown, ContextPresentation, ContextUsageSource, ContextUsageTiming, QueueItemView, ToolPresentation } from '../shared/types.ts';

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
  | { id: string; kind: 'assistant'; content: string; messageId?: string; runId?: string; turn?: number; final?: boolean }
  | { id: string; kind: 'tool'; tool: ToolPresentation }
  | { id: string; kind: 'context'; context: ContextPresentation }
  | { id: string; kind: 'approval'; approvalRef: string; approvalKind: 'tool'; toolName: string; effect: ApprovalEffect; title: string; target?: string; reason: string; fingerprint: string; options: ApprovalOption[]; resolved?: ApprovalOption }
  | { id: string; kind: 'error'; title: string; message: string };

export type ConversationViewSnapshot = {
  ref: string;
  title: string;
  state: ConversationState;
  activeRun?: { runId: string; phase: 'running' | 'waiting_confirm' | 'closing' | 'stopping' };
  queuedItems: QueueItemView[];
  queuePaused: boolean;
  updatedAt: string;
  revision: number;
  items: ConversationItem[];
  contextUsage: ContextUsageView;
};

export type ModelDisplayDescriptor = {
  displayName: string;
  contextWindow?: number;
  providerDisplayName?: string;
};
