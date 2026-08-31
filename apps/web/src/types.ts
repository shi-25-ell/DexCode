export type ConversationScope = { kind: 'general' } | { kind: 'workspace'; workspaceRef: string };

export type CapabilityId = 'mcp' | 'tools' | 'skills' | 'approval' | 'project-knowledge' | 'memory';
export type ApprovalMode = 'read_only' | 'allowlist' | 'full_access';
export type ApprovalEffect = 'read' | 'write' | 'execute' | 'external' | 'interactive';
export type ApprovalOption = 'allow_once' | 'allow_whitelist' | 'deny';

export type Capability = {
  id: CapabilityId;
  label: string;
  route: string;
  icon: 'network' | 'wrench' | 'sparkles' | 'shield' | 'book' | 'brain';
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
  toolName: string;
  category: 'read' | 'file' | 'command' | 'search' | 'skill' | 'mcp' | 'snapshot' | 'memory' | 'other';
  name: string;
  target?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
  summary: string;
  rawOutput?: string;
  truncated?: boolean;
  approval?: { status: 'not_required' | 'pending' | 'approved' | 'denied'; addedToWhitelist: boolean };
  fileChange?: { path: string; kind: 'created' | 'modified'; additions: number; deletions: number; binary?: boolean; diff: string; truncated: boolean };
};

export type ToolBatchPresentation = {
  id: string;
  type: 'inspection' | 'modification' | 'command';
  members: ToolPresentation[];
};

export type ConversationItem =
  | { id: string; kind: 'user'; content: string }
  | { id: string; kind: 'assistant'; content: string; messageId?: string; runId?: string; turn?: number; final?: boolean }
  | { id: string; kind: 'tool'; tool: ToolPresentation }
  | { id: string; kind: 'tool_batch'; batch: ToolBatchPresentation }
  | { id: string; kind: 'context'; context: ContextPresentation }
  | { id: string; kind: 'agent_activity'; sourceRunId: string; delegationGroupId?: string; agentRunIds: string[] }
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
  managedMemory: number;
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
  agents?: AgentTreeSnapshot | null;
};

export type AgentDefinitionView = { name: string; description: string };
export type AgentRecordView = {
  agentId: string; sessionId: string; rootAgentId: string; parentAgentId: string | null; createdByRunId: string;
  name: string; task: string; contextMode: 'fresh' | 'fork'; isolation: 'shared' | 'worktree'; definitionName: string;
  status: 'creating' | 'running' | 'stopping' | 'idle'; currentRunId?: string; lastRunId?: string;
  createdAt: string; updatedAt: string;
};
export type AgentRunView = {
  agentRunId: string; agentId: string; invokedByRunId: string; trigger: 'spawn' | 'followup';
  invokedByTurn?: number; invokedByToolCallId?: string; delegationGroupId?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'limited'; input: string; startedAt: string; completedAt?: string;
  usage?: { totalTokens: number };
  result?: { finalContent: string; terminationReason: string; toolsUsed: string[]; filesModified: string[]; usage?: { totalTokens: number }; error?: { code: string; message: string } };
};
export type AgentTreeSnapshot = { version: 1; sessionId: string; rootAgentId: string; revision: number; agents: AgentRecordView[]; runs: AgentRunView[] };
export type AgentTranscriptMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };
export type AgentToolView = { callId: string; name: string; status: 'running' | 'finished'; presentation?: ToolPresentation };
export type AgentDetail = { agent: AgentRecordView; runs: AgentRunView[]; messages: AgentTranscriptMessage[]; tools: AgentToolView[] };
export type AgentActivityEnvelope = { version: 1; sessionId: string; seq: number; at: string; event: { type: string; agent?: AgentRecordView; agentId?: string; run?: AgentRunView; status?: AgentRecordView['status']; revision?: number } };

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
