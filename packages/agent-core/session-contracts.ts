import type {
  ChatMessage,
  CompactionCheckpoint,
  ContextActivity,
  ContextArtifactRef,
  ContextManifest,
  ContextPresentation,
  ContextSummaryRecord,
  ContextUsageSnapshot,
  RunReport,
  RunContext,
  Session,
  SessionScope,
  TaskSummary,
  ToolPresentation,
} from '../shared/types.ts';

export type BeginRunInput = {
  sessionId: string;
  runId: string;
  userMessage: ChatMessage;
  context: RunContext;
  clientRequestId?: string;
};

export type AppendRunMessageInput = {
  sessionId: string;
  runId: string;
  message: ChatMessage;
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
  readProjectMemory(workspaceId?: string): Promise<string>;
}
