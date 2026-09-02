import type { ChatMessage, ContextArtifactRef, SessionLedgerRecord, SessionScope, TaskSummary } from '../shared/types.ts';

export const SESSION_JOURNAL_VERSION = 1 as const;

export type SessionJournalHeader = {
  kind: 'header';
  version: typeof SESSION_JOURNAL_VERSION;
  sessionId: string;
  scope: SessionScope;
  createdAt: string;
};

export type SessionJournalRecord =
  | SessionLedgerRecord
  | { type: 'session_meta_updated'; title?: string | null; archived?: boolean; selectedModel?: string | null }
  | { type: 'session_message_committed'; message: ChatMessage }
  | { type: 'task_summary_committed'; summary: TaskSummary }
  | { type: 'client_request_registered'; clientRequestId: string }
  | { type: 'context_artifact_registered'; artifact: ContextArtifactRef };

export type SessionJournalCommit = {
  kind: 'commit';
  version: typeof SESSION_JOURNAL_VERSION;
  commitId: string;
  sessionId: string;
  revision: number;
  at: string;
  records: SessionJournalRecord[];
};

export type SessionJournalMeta = {
  version: 1;
  sessionId: string;
  scope: SessionScope;
  createdAt: string;
  updatedAt: string;
  title: string;
  archived: boolean;
  state: 'idle' | 'running' | 'waiting' | 'failed';
  messageCount: number;
  taskCount: number;
  lastMessage: string;
  materialized: boolean;
  revision: number;
  journalBytes: number;
  clientRequestIds: string[];
  checksum: string;
};
