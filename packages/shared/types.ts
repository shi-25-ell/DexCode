// ── LLM 标准消息类型（与 OpenAI tool use API 对齐）──

export type SystemMessage = {
  role: 'system';
  content: string;
};

export type UserMessage = {
  role: 'user';
  content: string;
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
};

export type ToolResultMessage = {
  role: 'tool';
  tool_call_id: string;
  name: string;
  content: string;
};

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// ── 任务摘要（会话间记忆载体）──

export type TaskSummary = {
  taskId: string;
  prompt: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'aborted' | 'failed' | 'limited';
  summary: string;
  toolsUsed: string[];
  filesModified: string[];
  skillsUsed?: string[];
};

export type RunStatus = 'completed' | 'aborted' | 'failed' | 'limited';

export type ContextBreakdown = {
  systemPrompt: number;
  workspaceCode: number;
  recentConversation: number;
  toolResults: number;
  projectMemory: number;
  toolDefinitions: number;
  other: number;
};

export type ContextUsageSource = 'provider' | 'calibrated' | 'estimated' | 'unknown';
export type ContextUsageTiming = 'next_request' | 'last_request';

export type ContextUsageSnapshot = {
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

export type ContextPolicy = {
  enabled: boolean;
  contextWindowTokens?: number;
  maxOutputTokens: number;
  reserveTokens: number;
  targetRatio: number;
  latestToolResultsToKeep: number;
  maxConversationMessages: number;
  latestToolBatchChars: number;
  largeToolResultChars: number;
};

export type ContextCompactionStrategy = 'four_layer' | 'legacy';

export type ContextArtifactRef = {
  version: 1;
  id: string;
  sessionId: string;
  kind: 'tool-result' | 'transcript';
  digest: string;
  chars: number;
  createdAt: string;
  storageKey?: string;
};

export type ContextLayer = 'large_tool_results' | 'middle_archive' | 'old_tool_results' | 'summary';

export type ContextActivity = {
  operationRef: string;
  layers: ContextLayer[];
  beforeTokens: number;
  afterTokens: number;
  beforeBreakdown: ContextBreakdown;
  afterBreakdown: ContextBreakdown;
  externalizedToolResults: number;
  archivedMessages: number;
  archivedConversationSegments: number;
  compactedToolResults: number;
  summarizedMessages: number;
  retainedConversationSegments: number;
  retainedMessageCount: number;
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

export type RunReport = {
  version: 1;
  runId: string;
  context?: RunContext;
  status: RunStatus;
  terminationReason: string;
  finalAnswer?: string;
  startedAt: string;
  completedAt: string;
  modelTurnCount: number;
  modelAttemptCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    unknown: number;
  };
  contextStrategy?: ContextCompactionStrategy;
  contextSummaryUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latestInputTokens?: number;
  latestContextUsage?: ContextUsageSnapshot;
  toolsUsed: string[];
  filesModified: string[];
  error?: { code: string; message: string };
};

export type ContextManifestV1 = {
  version: 1;
  id: string;
  runId: string;
  estimatedInputTokens: number;
  selectedMessageCount: number;
  omittedMessageCount: number;
  requestDigest: string;
  checkpointId?: string;
};

export type ContextManifestV2 = {
  version: 2;
  id: string;
  runId: string;
  turn: number;
  attempt: number;
  createdAt: string;
  requestDigest: string;
  requestSerializedChars: number;
  estimatedInputTokens: number;
  actualInputTokens?: number;
  tokenSource: ContextUsageSource;
  contextWindowTokens?: number;
  maxOutputTokens: number;
  reserveTokens: number;
  hardLimitTokens?: number;
  targetTokens?: number;
  breakdown: ContextBreakdown;
  layers: ContextLayer[];
  activity?: ContextActivity;
  summaryRecordId?: string;
  artifactRefs: ContextArtifactRef[];
  includedToolResultIds: string[];
};

export type ContextManifest = ContextManifestV1 | ContextManifestV2;

export type CompactionCheckpoint = {
  version: 1;
  id: string;
  sourceMessageCount: number;
  sourceDigest: string;
  summary: string;
  strategyVersion: 'deterministic-summary-v1';
};

export type ContextSummaryRecord = {
  version: 2;
  id: string;
  runId: string;
  turn: number;
  strategyVersion: 'structured-summary-v2';
  sourceDigest: string;
  coveredMessageCount: number;
  summary: string;
  retainedTail: ChatMessage[];
  retainedTailDigest: string;
  tokensBefore: number;
  tokensAfter: number;
  summaryModel: string;
  summaryUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  createdAt: string;
  artifactRefs: ContextArtifactRef[];
};

export type ToolViewStatus = 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';

export type ToolPresentation = {
  callRef: string;
  category: 'read' | 'file' | 'command' | 'search' | 'skill' | 'mcp' | 'snapshot' | 'other';
  name: string;
  target?: string;
  status: ToolViewStatus;
  summary: string;
  rawOutput?: string;
  truncated?: boolean;
  fileChange?: {
    path: string;
    additions?: number;
    deletions?: number;
    binary?: boolean;
  };
};

export type SessionLedgerRecord =
  | { seq: number; at: string; runId: string; type: 'run_started'; context?: RunContext }
  | { seq: number; at: string; runId: string; type: 'message'; message: ChatMessage }
  | { seq: number; at: string; runId: string; type: 'tool_started'; callId: string; tool: string; input?: Record<string, unknown> }
  | { seq: number; at: string; runId: string; type: 'tool_completed'; callId: string; presentation: ToolPresentation }
  | { seq: number; at: string; runId: string; type: 'context_committed'; manifest: ContextManifest; checkpoint?: CompactionCheckpoint }
  | { seq: number; at: string; runId: string; type: 'context_prepare_committed'; manifest: ContextManifestV2 }
  | { seq: number; at: string; runId: string; type: 'context_compaction_started'; operationRef: string }
  | { seq: number; at: string; runId: string; type: 'context_compaction_completed'; presentation: ContextPresentation; summaryRecordId?: string }
  | { seq: number; at: string; runId: string; type: 'context_compaction_failed'; operationRef: string; reason: NonNullable<ContextPresentation['reason']> }
  | { seq: number; at: string; runId: string; type: 'context_usage_observed'; manifestId: string; usage: ContextUsageSnapshot }
  | { seq: number; at: string; runId: string; type: 'run_terminal'; report: RunReport }
  | { seq: number; at: string; runId: string; type: 'recovery'; reason: 'interrupted' };

export type FileDiff = {
  path: string;
  before: string | null;
  after: string | null;
};


// ── 会话对象 ──

export type SessionScope =
  | { kind: 'general' }
  | { kind: 'workspace'; workspaceId: string };

export type RunContext = {
  scope: SessionScope;
  workspace?: {
    workspaceId: string;
    rootPath: string;
  };
};

export type Session = {
  sessionId: string;
  scope: SessionScope;
  createdAt: string;
  updatedAt: string;
  title?: string;
  archived?: boolean;
  messages: ChatMessage[];
  taskSummaries: TaskSummary[];
  activeTaskId: string | null;
  revision?: number;
  ledger?: SessionLedgerRecord[];
  runReports?: RunReport[];
  contextManifests?: ContextManifest[];
  compactionCheckpoints?: CompactionCheckpoint[];
  contextSummaries?: ContextSummaryRecord[];
  contextArtifacts?: ContextArtifactRef[];
  clientRequestIds?: string[];
};

export type SessionMeta = {
  title?: string;
  archived?: boolean;
};

export type ToolInfo = {
  name: string;
  description: string;
  source: 'local' | 'external';
  enabled: boolean;
  callCount: number;
  successCount: number;
  avgDurationMs: number;
  lastCalledAt: string | null;
};

export type ToolCallLogEntry = {
  id: string;
  toolName: string;
  argsPreview: string;
  ok: boolean;
  durationMs: number;
  at: string;
  resultPreview: string;
  error?: string;
};

// ── SSE 事件类型（向后兼容原有 chunk/tool/result/error，新增以下类型）──

export type ChunkEvent = {
  type: 'chunk';
  chunk: string;
};

export type ReasoningChunkEvent = {
  type: 'reasoning_chunk';
  chunk: string;
};

export type ToolStatusEvent = {
  type: 'tool_status';
  callId: string;
  tool: string;
  status: 'running' | 'settled';
};

export type ToolEvent = {
  type: 'tool';
  tool: string;
  summary?: string;
  detail?: string;
};

export type ToolViewEvent = {
  type: 'tool_view';
  presentation: ToolPresentation;
};

export type ContextUsageEvent = {
  type: 'context_usage';
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

export type ContextActivityEvent = {
  type: 'context_activity';
  presentation: ContextPresentation;
};

export type ResultEvent = {
  type: 'result';
  result: unknown;
};

export type ErrorEvent = {
  type: 'error';
  message: string;
};

export type CommandRisk = 'low' | 'medium' | 'high';

export type ConfirmRequestEvent = {
  type: 'confirm_request';
  taskId: string;
  confirmId: string;
  question: string;
  options?: string[];
};

export type CommandConfirmRequestEvent = {
  type: 'command_confirm_request';
  taskId: string;
  confirmId: string;
  command: string;
  cwd: string;
  risk: CommandRisk;
  reason: string;
};

export type ConfirmResolvedEvent = {
  type: 'confirm_resolved';
  confirmId: string;
  answer: string;
};

export type TaskStatusEvent = {
  type: 'task_status';
  taskId: string;
  status: 'planning' | 'executing' | 'waiting_confirm' | 'summarizing' | 'done' | 'aborted' | 'error';
  note?: string;
};

export type SessionEvent = {
  type: 'session';
  sessionId: string;
  isNew: boolean;
};

export type SkillEvent = {
  type: 'skill';
  skill: string;
  action: 'listed' | 'read' | 'activated' | 'deactivated';
  trigger?: 'implicit' | 'explicit';
  reason?: string;
  summary?: string;
};

export type AgentEvent =
  | ChunkEvent
  | ReasoningChunkEvent
  | ToolStatusEvent
  | ToolEvent
  | ToolViewEvent
  | ContextUsageEvent
  | ContextActivityEvent
  | ResultEvent
  | ErrorEvent
  | ConfirmRequestEvent
  | CommandConfirmRequestEvent
  | ConfirmResolvedEvent
  | TaskStatusEvent
  | SessionEvent
  | SkillEvent;

// ── 挂起确认（服务端内存中维护）──

export type PendingConfirm = {
  confirmId: string;
  taskId: string;
  sessionId: string;
  question: string;
  options?: string[];
  createdAt: number;
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
};

export type PendingCommandConfirm = {
  confirmId: string;
  taskId: string;
  sessionId: string;
  command: string;
  cwd: string;
  risk: CommandRisk;
  reason: string;
  createdAt: number;
  resolve: (decision: 'allow_once' | 'allow_whitelist' | 'deny') => void;
  reject: (reason: Error) => void;
};
