import type {
  ContextManifestV2,
  Session,
  SessionLedgerRecord,
} from '../shared/types.ts';
import type {
  SessionJournalCommit,
  SessionJournalHeader,
  SessionJournalRecord,
} from './journal-types.ts';

export class SessionJournalInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionJournalInvariantError';
  }
}

export function projectionFromHeader(header: SessionJournalHeader): Session {
  return {
    sessionId: header.sessionId,
    scope: structuredClone(header.scope),
    createdAt: header.createdAt,
    updatedAt: header.createdAt,
    messages: [],
    taskSummaries: [],
    activeTaskId: null,
    revision: 0,
    ledger: [],
    runReports: [],
    contextManifests: [],
    compactionCheckpoints: [],
    contextSummaries: [],
    contextArtifacts: [],
    clientRequestIds: [],
  };
}

const LEDGER_TYPES = new Set([
  'run_started', 'message', 'tool_started', 'tool_completed', 'approval_requested', 'approval_resolved',
  'context_committed', 'context_prepare_committed', 'context_compaction_started', 'context_compaction_completed',
  'context_compaction_failed', 'context_usage_observed', 'run_terminal', 'recovery', 'queue_enqueued',
  'queue_retargeted', 'queue_requeued', 'queue_consumed', 'queue_cancelled', 'queue_reordered',
  'queue_chain_paused', 'queue_chain_resumed',
]);

function appendLedger(session: Session, record: SessionJournalRecord): void {
  const ledgerRecord = record as SessionLedgerRecord;
  const expected = (session.ledger?.at(-1)?.seq ?? 0) + 1;
  if (ledgerRecord.seq !== expected) {
    throw new SessionJournalInvariantError(`ledger sequence expected ${expected}, received ${String(ledgerRecord.seq)}`);
  }
  session.ledger!.push(structuredClone(ledgerRecord));
}

function applyRecord(session: Session, record: SessionJournalRecord): void {
  switch (record.type) {
    case 'session_meta_updated':
      if ('title' in record) {
        if (record.title === null) delete session.title;
        else session.title = record.title;
      }
      if (record.archived !== undefined) session.archived = record.archived;
      if ('selectedModel' in record) {
        if (record.selectedModel === null) delete session.selectedModel;
        else session.selectedModel = record.selectedModel;
      }
      if ('selectedModelConnectionFingerprint' in record) {
        if (record.selectedModelConnectionFingerprint === null) delete session.selectedModelConnectionFingerprint;
        else session.selectedModelConnectionFingerprint = record.selectedModelConnectionFingerprint;
      }
      return;
    case 'session_message_committed':
      session.messages.push(structuredClone(record.message));
      return;
    case 'task_summary_committed':
      session.taskSummaries.push(structuredClone(record.summary));
      return;
    case 'client_request_registered':
      if (!session.clientRequestIds!.includes(record.clientRequestId)) session.clientRequestIds!.push(record.clientRequestId);
      return;
    case 'context_artifact_registered':
      if (!session.contextArtifacts!.some((artifact) => artifact.id === record.artifact.id)) {
        session.contextArtifacts!.push(structuredClone(record.artifact));
      }
      return;
    case 'run_started':
      if (session.activeTaskId) throw new SessionJournalInvariantError(`Run already active: ${session.activeTaskId}`);
      session.activeTaskId = record.runId;
      appendLedger(session, record);
      return;
    case 'message':
      session.messages.push(structuredClone(record.message));
      appendLedger(session, record);
      return;
    case 'run_terminal': {
      if (session.runReports!.some((report) => report.runId === record.report.runId)) {
        throw new SessionJournalInvariantError(`Run terminal repeated: ${record.report.runId}`);
      }
      if (session.activeTaskId !== record.runId) {
        throw new SessionJournalInvariantError(`Run terminal does not match active Run: ${record.runId}`);
      }
      session.activeTaskId = null;
      session.runReports!.push(structuredClone(record.report));
      if (record.summary) session.taskSummaries.push(structuredClone(record.summary));
      appendLedger(session, record);
      return;
    }
    case 'context_committed':
      session.contextManifests!.push(structuredClone(record.manifest));
      if (record.checkpoint) session.compactionCheckpoints!.push(structuredClone(record.checkpoint));
      appendLedger(session, record);
      return;
    case 'context_prepare_committed':
      session.contextManifests!.push(structuredClone(record.manifest));
      if (record.summaryRecord) session.contextSummaries!.push(structuredClone(record.summaryRecord));
      appendLedger(session, record);
      return;
    case 'context_usage_observed': {
      const index = session.contextManifests!.findIndex((manifest) => manifest.version === 2 && manifest.id === record.manifestId);
      if (index < 0) throw new SessionJournalInvariantError(`Context manifest not found: ${record.manifestId}`);
      const manifest = session.contextManifests![index] as ContextManifestV2;
      session.contextManifests![index] = {
        ...manifest,
        ...(record.actualInputTokens !== undefined
          ? { actualInputTokens: record.actualInputTokens }
          : record.usage.usedTokens !== undefined
            ? { actualInputTokens: record.usage.usedTokens }
            : {}),
        tokenSource: 'provider',
        breakdown: record.usage.breakdown ?? manifest.breakdown,
      };
      appendLedger(session, record);
      return;
    }
    default:
      if (!LEDGER_TYPES.has(record.type)) throw new SessionJournalInvariantError(`Unsupported journal record: ${record.type}`);
      appendLedger(session, record);
  }
}

export function applyCommit(session: Session, commit: SessionJournalCommit, seenCommitIds?: Set<string>): Session {
  validateCommit(session, commit, seenCommitIds);
  for (const record of commit.records) applyRecord(session, record);
  session.revision = commit.revision;
  session.updatedAt = commit.at;
  seenCommitIds?.add(commit.commitId);
  return session;
}

export function validateCommit(session: Session, commit: SessionJournalCommit, seenCommitIds?: Set<string>): void {
  if (commit.sessionId !== session.sessionId) throw new SessionJournalInvariantError('Commit Session id does not match header');
  const expectedRevision = (session.revision ?? 0) + 1;
  if (commit.revision !== expectedRevision) {
    throw new SessionJournalInvariantError(`revision expected ${expectedRevision}, received ${commit.revision}`);
  }
  if (seenCommitIds?.has(commit.commitId)) throw new SessionJournalInvariantError(`commitId repeated: ${commit.commitId}`);
  let activeRunId = session.activeTaskId;
  let nextSeq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
  const terminalRunIds = new Set((session.runReports ?? []).map((report) => report.runId));
  const manifestIds = new Set((session.contextManifests ?? []).map((manifest) => manifest.id));
  for (const record of commit.records) {
    if (LEDGER_TYPES.has(record.type)) {
      if (!('seq' in record) || record.seq !== nextSeq) {
        throw new SessionJournalInvariantError(`ledger sequence expected ${nextSeq}, received ${'seq' in record ? String(record.seq) : 'missing'}`);
      }
      nextSeq += 1;
    }
    if (record.type === 'run_started') {
      if (activeRunId) throw new SessionJournalInvariantError(`Run already active: ${activeRunId}`);
      activeRunId = record.runId;
    } else if (record.type === 'run_terminal') {
      if (terminalRunIds.has(record.report.runId)) throw new SessionJournalInvariantError(`Run terminal repeated: ${record.report.runId}`);
      if (activeRunId !== record.runId) throw new SessionJournalInvariantError(`Run terminal does not match active Run: ${record.runId}`);
      terminalRunIds.add(record.report.runId);
      activeRunId = null;
    } else if (record.type === 'context_committed' || record.type === 'context_prepare_committed') {
      manifestIds.add(record.manifest.id);
    } else if (record.type === 'context_usage_observed' && !manifestIds.has(record.manifestId)) {
      throw new SessionJournalInvariantError(`Context manifest not found: ${record.manifestId}`);
    }
  }
}
