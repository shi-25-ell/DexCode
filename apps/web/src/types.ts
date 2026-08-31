export type ConversationScope = { kind: 'general' } | { kind: 'workspace'; workspaceRef: string };

export type CapabilityId = 'mcp' | 'tools' | 'skills' | 'approval' | 'project-knowledge';
export type ApprovalMode = 'read_only' | 'allowlist' | 'full_access';
export type ApprovalEffect = 'read' | 'write' | 'execute' | 'external' | 'interactive';
export type ApprovalOption = 'allow_once' | 'allow_whitelist' | 'deny';

export type Capability = {
  id: CapabilityId;
  label: string;
  route: string;
  icon: 'network' | 'wrench' | 'sparkles' | 'shield' | 'book';
  workspaceRequired: boolean;
};

export type ConversationListItem = {
  ref: string;
  title: string;
  preview?: string;
  updatedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'failed';
  archived: boolean;
};

export type ToolPresentation = {
  callRef: string;
  category: 'read' | 'file' | 'command' | 'search' | 'skill' | 'mcp' | 'snapshot' | 'other';
  name: string;
  target?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
  summary: string;
  rawOutput?: string;
  truncated?: boolean;
  fileChange?: { path: string; additions?: number; deletions?: number; binary?: boolean };
};

export type ConversationItem =
  | { id: string; kind: 'user'; content: string }
  | { id: string; kind: 'assistant'; content: string; messageId?: string; runId?: string; turn?: number; final?: boolean }
  | { id: string; kind: 'tool'; tool: ToolPresentation }
  | { id: string; kind: 'context'; context: ContextPresentation }
  | { id: string; kind: 'approval'; approvalRef: string; approvalKind: 'question' | 'command' | 'tool'; title: string; target?: string; reason?: string; toolName?: string; effect?: ApprovalEffect; fingerprint?: string; options: string[]; resolved?: string }
  | { id: string; kind: 'error'; title: string; message: string };

export type ContextUsage = {
  usedTokens?: number;
  contextWindowTokens?: number;
  hardLimitTokens?: number;
  targetTokens?: number;
  percentage?: number;
  source: 'provider' | 'calibrated' | 'estimated' | 'unknown';
  timing: 'next_request' | 'last_request';
  asOfTurn?: number;
  asOfAttempt?: number;
  breakdown?: ContextBreakdown;
  breakdownEstimated?: boolean;
};

export type ContextBreakdown = {
  systemPrompt: number;
  workspaceCode: number;
  recentConversation: number;
  toolResults: number;
  projectMemory: number;
  toolDefinitions: number;
  other: number;
};

export type ContextPresentation = {
  operationRef: string;
  status: 'running' | 'completed' | 'failed';
  beforeTokens?: number;
  afterTokens?: number;
  breakdown?: ContextBreakdown;
  externalizedToolResults?: number;
  archivedMessages?: number;
  archivedConversationSegments?: number;
  compactedToolResults?: number;
  summarizedMessages?: number;
  retainedConversationSegments?: number;
  retainedMessageCount?: number;
  reason?: 'summary_failed' | 'cancelled' | 'invalid_summary' | 'interrupted' | 'persistence_failed';
};

export type ConversationSnapshot = {
  ref: string;
  title: string;
  state: 'idle' | 'running' | 'waiting' | 'failed';
  activeRun?: { runId: string; phase: 'running' | 'waiting_confirm' | 'closing' | 'stopping' };
  queuedItems: QueueItem[];
  queuePaused: boolean;
  updatedAt: string;
  revision: number;
  items: ConversationItem[];
  contextUsage: ContextUsage;
};

export type QueueDelivery = 'next_run' | 'steer';
export type FollowUpBehavior = 'queue' | 'steer';

export type QueueItem = {
  itemId: string;
  sessionId: string;
  content: string;
  delivery: QueueDelivery;
  status: 'queued' | 'consumed' | 'cancelled';
  targetRunId?: string;
  createdAt: string;
  updatedAt: string;
  position: number;
  revision: number;
  consumedRunId?: string;
};

export type QueueMutationOutcome =
  | { outcome: 'queued'; item: QueueItem; sessionRevision: number; replayed?: boolean }
  | { outcome: 'steered'; item: QueueItem; targetRunId: string; sessionRevision: number; replayed?: boolean }
  | { outcome: 'remained_queued'; item: QueueItem; reason: 'run_changed' | 'run_closing'; sessionRevision: number }
  | { outcome: 'cancelled'; itemId: string; sessionRevision: number; replayed?: boolean }
  | { outcome: 'already_cancelled'; itemId: string; sessionRevision: number }
  | { outcome: 'already_consumed'; itemId: string; runId: string; sessionRevision: number };

export type ModelDescriptor = {
  displayName: string;
  contextWindow?: number;
  providerDisplayName?: string;
};
