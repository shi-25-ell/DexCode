import type { ContextSection } from '../context-engine/index.ts';
import type { AgentRunResult } from '../agent-core/agent-runtime.ts';
import type { ChatMessage } from '../shared/types.ts';

export const MANAGED_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type ManagedMemoryType = typeof MANAGED_MEMORY_TYPES[number];
export type ManagedMemoryMode = 'off' | 'observe' | 'on';
export type ManagedMemoryActor = 'main-agent' | 'child-agent' | 'memory-extractor' | 'memory-consolidator' | 'user';

export const MANAGED_MEMORY_LIMITS = {
  maxTopics: 200,
  frontmatterLines: 30,
  maxIndexLines: 200,
  maxIndexBytes: 25_000,
  maxIndexLineChars: 200,
  maxTopicBytes: 64 * 1024,
  maxSelectedTopics: 5,
  maxTopicRecallBytes: 4 * 1024,
  maxReadLines: 200,
  maxReadBytes: 16 * 1024,
  maxSearchResults: 50,
} as const;

export type ManagedMemorySettings = {
  version: 1;
  enabled: boolean;
  extractionEnabled: boolean;
  recallEnabled: boolean;
  consolidationEnabled: boolean;
  extractionEveryCompletedRuns: number;
  consolidationMinHours: number;
  consolidationMinSessions: number;
  generation: number;
};

export type ManagedMemorySettingsPatch = Partial<Omit<ManagedMemorySettings, 'version' | 'generation'>>;

export const DEFAULT_MANAGED_MEMORY_SETTINGS: ManagedMemorySettings = {
  version: 1,
  enabled: true,
  extractionEnabled: true,
  recallEnabled: true,
  consolidationEnabled: false,
  extractionEveryCompletedRuns: 1,
  consolidationMinHours: 24,
  consolidationMinSessions: 5,
  generation: 0,
};

export type MemoryHeader = {
  path: string;
  name: string;
  description: string;
  type: ManagedMemoryType;
  mtimeMs: number;
  bytes: number;
  digest: string;
};

export type MemoryTopic = MemoryHeader & {
  body: string;
  raw: string;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
};

export type MemoryFileView = {
  path: string;
  raw: string;
  digest: string;
  mtimeMs: number;
  bytes: number;
  truncated: boolean;
  warning?: string;
};

export type ManagedMemoryContextRef = {
  path: string;
  digest: string;
  mtimeMs: number;
  bytes: number;
  truncated: boolean;
  reason: 'index' | 'relevant';
};

export type PreparedManagedMemory = {
  enabled: boolean;
  generation: number;
  sections: ContextSection[];
  refs: ManagedMemoryContextRef[];
  recall: {
    candidateCount: number;
    selectedCount: number;
    selector: 'model' | 'lexical-fallback' | 'none';
    durationMs: number;
    warning?: string;
  };
};

export type PrepareManagedMemoryInput = {
  workspaceId: string;
  sessionId: string;
  contextOwnerId?: string;
  runId: string;
  query: string;
  signal?: AbortSignal;
};

export type EnqueueMemoryExtractionInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  completedAt: string;
  status: 'completed' | 'aborted' | 'failed' | 'limited';
  messages: ChatMessage[];
  systemSections: ContextSection[];
  toolCalls: Array<{ name: string; input: unknown; outcome?: unknown }>;
};

export type MemoryMutationResult = {
  ok: boolean;
  mutationCommitted: boolean;
  action: 'upsert' | 'remove';
  path: string;
  operationId: string;
  digest?: string;
  indexDigest?: string;
  replayed?: boolean;
  error?: string;
  code?: 'MEMORY_CONFLICT' | 'MEMORY_REJECTED' | 'MEMORY_DISABLED' | 'MEMORY_GENERATION_CHANGED';
  latestDigest?: string;
};

export type MemoryUpsertInput = {
  workspaceId: string;
  actor: ManagedMemoryActor;
  path: string;
  name: string;
  description: string;
  type: ManagedMemoryType;
  body: string;
  indexTitle: string;
  indexHook: string;
  expectedDigest?: string | null;
  operationId: string;
  runId?: string;
  sessionId?: string;
  expectedGeneration?: number;
};

export type MemoryRemoveInput = {
  workspaceId: string;
  actor: ManagedMemoryActor;
  path: string;
  expectedDigest: string;
  reason: string;
  operationId: string;
  runId?: string;
  sessionId?: string;
  expectedGeneration?: number;
};

export type ManagedMemoryOperation = {
  version: 1;
  operationId: string;
  workspaceId: string;
  at: string;
  actor: ManagedMemoryActor;
  action: 'upsert' | 'remove' | 'settings';
  path?: string;
  beforeDigest?: string;
  afterDigest?: string;
  runId?: string;
  sessionId?: string;
  outcome: 'committed' | 'conflict' | 'rejected' | 'failed';
  reason?: string;
};

export type ManagedMemorySnapshot = {
  workspaceId: string;
  mode: ManagedMemoryMode;
  settings: ManagedMemorySettings;
  topicCount: number;
  indexExists: boolean;
  totalBytes: number;
  degraded: boolean;
  diagnostics: string[];
  background: {
    inProgress: boolean;
    pendingSessions: number;
    lastExtractionAt?: string;
    lastConsolidationAt?: string;
    lastError?: string;
  };
};

export type ClearProjectMemoryInput = { confirmationToken: string };
export type ClearProjectMemoryResult = { deletedFiles: number; releasedBytes: number; generation: number };
export type ManagedMemoryDrainResult = { completed: boolean; aborted: number; pending: number };

export type MemorySelectionInput = {
  query: string;
  candidates: MemoryHeader[];
  alreadySurfaced: ReadonlySet<string>;
  signal?: AbortSignal;
};

export interface MemorySelector {
  select(input: MemorySelectionInput): Promise<string[]>;
}

export type InternalMemoryRunInput = {
  kind: 'extraction' | 'consolidation';
  parentRunId?: string;
  sessionId?: string;
  generation: number;
  messages: ChatMessage[];
  systemSections: ContextSection[];
  signal?: AbortSignal;
};

export interface InternalMemoryRunner {
  run(input: InternalMemoryRunInput): Promise<AgentRunResult>;
}

export interface ManagedMemorySystem {
  prepareRun(input: PrepareManagedMemoryInput): Promise<PreparedManagedMemory>;
  enqueueExtraction(input: EnqueueMemoryExtractionInput): void;
  drain(input?: { timeoutMs?: number }): Promise<ManagedMemoryDrainResult>;
  inspect(workspaceId: string): Promise<ManagedMemorySnapshot>;
  updateSettings(workspaceId: string, patch: ManagedMemorySettingsPatch): Promise<ManagedMemorySettings>;
  clearProjectMemory(workspaceId: string, input: ClearProjectMemoryInput): Promise<ClearProjectMemoryResult>;
}
