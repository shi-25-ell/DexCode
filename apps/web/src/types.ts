export type ConversationScope = { kind: 'general' } | { kind: 'workspace'; workspaceRef: string };

export type CapabilityId = 'mcp' | 'tools' | 'skills' | 'approval' | 'snapshots' | 'project-knowledge';
export type ApprovalMode = 'read_only' | 'allowlist' | 'full_access';
export type ApprovalEffect = 'read' | 'write' | 'execute' | 'external' | 'interactive';
export type ApprovalOption = 'allow_once' | 'allow_whitelist' | 'deny';

export type Capability = {
  id: CapabilityId;
  label: string;
  route: string;
  icon: 'network' | 'wrench' | 'sparkles' | 'shield' | 'camera' | 'book';
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
  status: 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
  summary: string;
  rawOutput?: string;
  truncated?: boolean;
  fileChange?: { path: string; additions?: number; deletions?: number; binary?: boolean };
};

export type ConversationItem =
  | { id: string; kind: 'user'; content: string }
  | { id: string; kind: 'assistant'; content: string }
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
  reason?: string;
};

export type ConversationSnapshot = {
  ref: string;
  title: string;
  state: 'idle' | 'running' | 'waiting' | 'failed';
  activeRun?: { runId: string; phase: 'running' | 'waiting_confirm' | 'closing' | 'stopping' };
  queuedItems: QueueItem[];
  queuePaused: boolean;
  revision: number;
  updatedAt: string;
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
  | { outcome: 'remained_queued'; item: QueueItem; reason: 'run_changed' | 'run_closing' | 'waiting_confirm'; sessionRevision: number }
  | { outcome: 'cancelled'; itemId: string; sessionRevision: number; replayed?: boolean }
  | { outcome: 'already_cancelled'; itemId: string; sessionRevision: number }
  | { outcome: 'already_consumed'; itemId: string; runId: string; sessionRevision: number };

export type ModelDescriptor = {
  displayName: string;
  contextWindow?: number;
  providerDisplayName?: string;
};

export type StreamEvent =
  | { type: 'session'; sessionId: string; isNew: boolean }
  | { type: 'chunk'; chunk: string }
  | { type: 'tool_view'; presentation: ToolPresentation }
  | ({ type: 'context_usage' } & ContextUsage)
  | { type: 'context_activity'; presentation: ContextPresentation }
  | { type: 'task_status'; status: string; taskId: string; note?: string }
  | { type: 'confirm_request'; confirmId: string; question: string; options?: string[] }
  | { type: 'command_confirm_request'; confirmId: string; command: string; cwd: string; risk: string; reason: string }
  | { type: 'approval_request'; taskId: string; approvalId: string; toolName: string; effect: ApprovalEffect; title: string; target?: string; reason: string; fingerprint: string; options: ApprovalOption[] }
  | { type: 'error'; message: string }
  | { type: 'result'; result: unknown }
  | { type: 'reasoning_chunk'; chunk: string }
  | { type: 'skill'; skill: string; action: string }
  | { type: 'tool_status'; callId: string; tool: string; status: string }
  | { type: 'queue_item_added'; sessionId: string; item: QueueItem; sessionRevision: number }
  | { type: 'queue_item_updated'; sessionId: string; item: QueueItem; sessionRevision: number }
  | { type: 'queue_item_removed'; sessionId: string; itemId: string; reason: string; sessionRevision: number }
  | { type: 'queue_reordered'; sessionId: string; orderedItemIds: string[]; sessionRevision: number }
  | { type: 'run_started'; sessionId: string; runId: string; sourceItemId?: string }
  | { type: 'user_message_committed'; sessionId: string; runId: string; itemId: string }
  | { type: 'context_refresh_started' | 'context_refresh_completed'; sessionId: string; runId: string; itemId: string }
  | { type: 'context_refresh_failed'; sessionId: string; runId: string; itemId: string; message: string }
  | { type: 'run_chain_paused'; sessionId: string; reason: 'user_stop' | 'disconnect' | 'failure' | 'recovery' };
