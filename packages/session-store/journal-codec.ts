import type { SessionScope } from '../shared/types.ts';
import {
  SESSION_JOURNAL_VERSION,
  type SessionJournalCommit,
  type SessionJournalHeader,
  type SessionJournalRecord,
} from './journal-types.ts';

export class SessionJournalDecodeError extends Error {
  readonly kind: 'syntax' | 'schema';

  constructor(message: string, options?: ErrorOptions & { kind?: 'syntax' | 'schema' }) {
    super(message, options);
    this.name = 'SessionJournalDecodeError';
    this.kind = options?.kind ?? 'schema';
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionJournalDecodeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function jsonObject(line: string, label: string): Record<string, unknown> {
  try {
    return object(JSON.parse(line), label);
  } catch (error) {
    if (error instanceof SessionJournalDecodeError) throw error;
    throw new SessionJournalDecodeError(`${label} is not valid JSON`, { cause: error, kind: 'syntax' });
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SessionJournalDecodeError(`${field} must be a non-empty string`);
  }
  return value;
}

function scope(value: unknown): SessionScope {
  const candidate = object(value, 'header.scope');
  if (candidate.kind === 'general') return { kind: 'general' };
  if (candidate.kind === 'workspace' && typeof candidate.workspaceId === 'string' && /^workspace-[a-zA-Z0-9-]+$/.test(candidate.workspaceId)) {
    return { kind: 'workspace', workspaceId: candidate.workspaceId };
  }
  throw new SessionJournalDecodeError('header.scope is invalid');
}

const RECORD_TYPES = new Set([
  'session_meta_updated',
  'session_message_committed',
  'task_summary_committed',
  'client_request_registered',
  'context_artifact_registered',
  'run_started',
  'message',
  'tool_started',
  'tool_completed',
  'approval_requested',
  'approval_resolved',
  'context_committed',
  'context_prepare_committed',
  'context_compaction_started',
  'context_compaction_completed',
  'context_compaction_failed',
  'context_usage_observed',
  'run_terminal',
  'recovery',
  'queue_enqueued',
  'queue_retargeted',
  'queue_requeued',
  'queue_consumed',
  'queue_cancelled',
  'queue_reordered',
  'queue_chain_paused',
  'queue_chain_resumed',
]);

function record(value: unknown, index: number): SessionJournalRecord {
  const candidate = object(value, `commit.records[${index}]`);
  if (typeof candidate.type !== 'string' || !RECORD_TYPES.has(candidate.type)) {
    throw new SessionJournalDecodeError(`commit.records[${index}].type is unsupported`);
  }
  if ('seq' in candidate && (!Number.isSafeInteger(candidate.seq) || (candidate.seq as number) <= 0)) {
    throw new SessionJournalDecodeError(`commit.records[${index}].seq is invalid`);
  }
  return candidate as SessionJournalRecord;
}

export function decodeHeader(line: string): SessionJournalHeader {
  const value = jsonObject(line, 'header');
  if (value.kind !== 'header') throw new SessionJournalDecodeError('first line is not a header');
  if (value.version !== SESSION_JOURNAL_VERSION) throw new SessionJournalDecodeError('header.version is unsupported');
  return {
    kind: 'header',
    version: SESSION_JOURNAL_VERSION,
    sessionId: nonEmptyString(value.sessionId, 'header.sessionId'),
    scope: scope(value.scope),
    createdAt: nonEmptyString(value.createdAt, 'header.createdAt'),
  };
}

export function decodeCommit(line: string): SessionJournalCommit {
  const value = jsonObject(line, 'commit');
  if (value.kind !== 'commit') throw new SessionJournalDecodeError('line is not a commit');
  if (value.version !== SESSION_JOURNAL_VERSION) throw new SessionJournalDecodeError('commit.version is unsupported');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) <= 0) {
    throw new SessionJournalDecodeError('commit.revision is invalid');
  }
  if (!Array.isArray(value.records) || value.records.length === 0) {
    throw new SessionJournalDecodeError('commit.records must be a non-empty array');
  }
  return {
    kind: 'commit',
    version: SESSION_JOURNAL_VERSION,
    commitId: nonEmptyString(value.commitId, 'commit.commitId'),
    sessionId: nonEmptyString(value.sessionId, 'commit.sessionId'),
    revision: value.revision as number,
    at: nonEmptyString(value.at, 'commit.at'),
    records: value.records.map(record),
  };
}

export function encodeHeader(header: SessionJournalHeader): string {
  return `${JSON.stringify(header)}\n`;
}

export function encodeCommit(commit: SessionJournalCommit): string {
  return `${JSON.stringify(commit)}\n`;
}
