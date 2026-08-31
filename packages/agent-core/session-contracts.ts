import type {
  ChatMessage,
  CompactionCheckpoint,
  ContextActivity,
  ContextArtifactRef,
  ContextManifest,
  ContextPresentation,
  ContextSummaryRecord,
  ContextUsageSnapshot,
  QueueDelivery,
  QueueItemView,
  QueuePauseReason,
  QueueRequeueReason,
  RunReport,
  RunContext,
  Session,
  SessionScope,
  TaskSummary,
  ToolPresentation,
  UserMessage,
} from '../shared/types.ts';

export type QueueMutationOutcome =
  | { outcome: 'queued'; item: QueueItemView; sessionRevision: number; replayed?: boolean }
  | { outcome: 'steered'; item: QueueItemView; targetRunId: string; sessionRevision: number; replayed?: boolean }
  | { outcome: 'remained_queued'; item: QueueItemView; reason: 'run_changed' | 'run_closing'; sessionRevision: number }
  | { outcome: 'cancelled'; itemId: string; sessionRevision: number; replayed?: boolean }
  | { outcome: 'already_cancelled'; itemId: string; sessionRevision: number }
  | { outcome: 'already_consumed'; itemId: string; runId: string; sessionRevision: number };

export class QueueMutationError extends Error {
  readonly code: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'RUN_MISMATCH' | 'INVALID_STATE' | 'INVALID_ORDER';

  constructor(
    code: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'RUN_MISMATCH' | 'INVALID_STATE' | 'INVALID_ORDER',
    message: string,
  ) {
    super(message);
    this.name = 'QueueMutationError';
    this.code = code;
  }
}

export type BeginRunInput = {
  sessionId: string;
  runId: string;
  userMessage: ChatMessage;
  context: RunContext;
  clientRequestId?: string;
  parentRunId?: string;
  profile?: string;
  origin?: string;
};

export type AppendRunMessageInput = {
  sessionId: string;
  runId: string;
  message: ChatMessage;
  messageId?: string;
  turn?: number;
};

export type MarkToolStartedInput = {
  sessionId: string;
  runId: string;
  callId: string;
  tool: string;
  input?: Record<string, unknown>;
};

export type CommitToolOutcomeInput = {
  sessionId: string;
  runId: string;
  message: ChatMessage;
  presentation: ToolPresentation;
};

export type FinishRunInput = {
  sessionId: string;
  report: RunReport;
  summary: TaskSummary;
};

export interface SessionRepository {
  loadSession(id: string): Promise<Session | null>;
  beginRun(input: BeginRunInput): Promise<Session>;
  appendRunMessage(input: AppendRunMessageInput): Promise<Session>;
  markToolStarted(input: MarkToolStartedInput): Promise<Session>;
  commitToolOutcome(input: CommitToolOutcomeInput): Promise<Session>;
  materializeRun(input: {
    scope: SessionScope;
    clientRequestId: string;
    runId: string;
    userMessage: ChatMessage;
    context: RunContext;
    parentRunId?: string;
    profile?: string;
    origin?: string;
  }): Promise<{ session: Session; created: boolean }>;
  commitContext(input: {
    sessionId: string;
    runId: string;
    manifest: ContextManifest;
    checkpoint?: CompactionCheckpoint;
    summaryRecord?: ContextSummaryRecord;
    activity?: ContextActivity;
  }): Promise<Session>;
  beginContextCompaction(input: { sessionId: string; runId: string; operationRef: string }): Promise<void>;
  failContextCompaction(input: {
    sessionId: string;
    runId: string;
    operationRef: string;
    reason: NonNullable<ContextPresentation['reason']>;
  }): Promise<void>;
  recordContextProviderUsage(input: {
    sessionId: string;
    runId: string;
    manifestId: string;
    actualInputTokens: number;
    usage: ContextUsageSnapshot;
  }): Promise<void>;
  putContextArtifact(input: {
    sessionId: string;
    runId: string;
    kind: ContextArtifactRef['kind'];
    sourceRef: string;
    content: string;
  }): Promise<ContextArtifactRef>;
  readContextArtifact(input: { sessionId: string; ref: string; offset?: number; limit?: number }): Promise<{
    ref: string;
    content: string;
    offset: number;
    nextOffset?: number;
    totalChars: number;
  }>;
  finishRun(input: FinishRunInput): Promise<{ session: Session; report: RunReport; committed: boolean }>;
  getQueue(sessionId: string): Promise<{ items: QueueItemView[]; pending: QueueItemView[]; paused: boolean; sessionRevision: number }>;
  enqueueQueueItem(input: { sessionId: string; content: string; delivery: QueueDelivery; operationId: string; targetRunId?: string; expectedSessionRevision?: number }): Promise<Extract<QueueMutationOutcome, { outcome: 'queued' }>>;
  promoteQueueItem(input: { sessionId: string; itemId: string; expectedRunId: string; operationId: string; expectedSessionRevision?: number }): Promise<Extract<QueueMutationOutcome, { outcome: 'steered' | 'already_consumed' }>>;
  cancelQueueItem(input: { sessionId: string; itemId: string; operationId: string; expectedSessionRevision?: number }): Promise<Extract<QueueMutationOutcome, { outcome: 'cancelled' | 'already_cancelled' | 'already_consumed' }>>;
  reorderQueueItems(input: { sessionId: string; orderedItemIds: string[]; operationId: string; expectedSessionRevision: number }): Promise<{ orderedItemIds: string[]; sessionRevision: number; replayed?: boolean }>;
  consumeSteer(input: { sessionId: string; runId: string; operationId: string }): Promise<{ item: QueueItemView; message: UserMessage; sessionRevision: number } | null>;
  beginRunFromQueue(input: { sessionId: string; runId: string; context: RunContext; operationId: string }): Promise<{ session: Session; item: QueueItemView; message: UserMessage } | null>;
  requeueSteers(input: { sessionId: string; runId: string; reason: QueueRequeueReason; operationId: string }): Promise<{ items: QueueItemView[]; sessionRevision: number }>;
  setQueuePaused(input: { sessionId: string; paused: boolean; operationId: string; reason?: QueuePauseReason }): Promise<{ paused: boolean; sessionRevision: number }>;
  readProjectMemory(workspaceId?: string): Promise<string>;
}
