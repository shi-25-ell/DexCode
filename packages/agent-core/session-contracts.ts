import type {
  ChatMessage,
  CompactionCheckpoint,
  ContextManifest,
  RunReport,
  RunContext,
  Session,
  TaskSummary,
} from '../shared/types.ts';

export type BeginRunInput = {
  sessionId: string;
  runId: string;
  userMessage: ChatMessage;
  context: RunContext;
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
  commitContext(input: { sessionId: string; runId: string; manifest: ContextManifest; checkpoint?: CompactionCheckpoint }): Promise<Session>;
  finishRun(input: FinishRunInput): Promise<{ session: Session; report: RunReport; committed: boolean }>;
  readProjectMemory(workspaceId?: string): Promise<string>;
}
