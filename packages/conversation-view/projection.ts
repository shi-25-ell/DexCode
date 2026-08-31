import type { Session, SessionLedgerRecord } from '../shared/types.ts';
import type { ConversationItem, ConversationListItem, ConversationState, ConversationViewSnapshot, ContextUsageView } from './contracts.ts';
import { safeDisplayOutput } from './output-policy.ts';
import { conversationTitle } from './title.ts';

function sessionState(session: Session): ConversationState {
  if (session.activeTaskId) return 'running';
  return session.runReports?.at(-1)?.status === 'failed' ? 'failed' : 'idle';
}

export function projectConversationListItem(session: Session): ConversationListItem {
  const firstUser = session.messages.find((message) => message.role === 'user');
  const latestUser = [...session.messages].reverse().find((message) => message.role === 'user');
  return {
    ref: session.sessionId,
    title: session.title?.trim() || conversationTitle(typeof firstUser?.content === 'string' ? firstUser.content : ''),
    ...(typeof latestUser?.content === 'string' ? { preview: latestUser.content.trim().slice(0, 120) } : {}),
    updatedAt: session.updatedAt,
    state: sessionState(session),
    archived: session.archived ?? false,
  };
}

function contextUsage(session: Session, contextWindow?: number): ContextUsageView {
  const observed = [...(session.ledger ?? [])].reverse().find((record) => record.type === 'context_usage_observed');
  if (observed?.type === 'context_usage_observed') return observed.usage;
  const reportUsage = session.runReports?.at(-1)?.latestContextUsage;
  if (reportUsage) return reportUsage;
  const manifest = [...(session.contextManifests ?? [])].reverse().find((candidate) => candidate.version === 2);
  if (manifest?.version === 2) {
    const usedTokens = manifest.actualInputTokens ?? manifest.estimatedInputTokens;
    const window = manifest.contextWindowTokens ?? contextWindow;
    return {
      usedTokens,
      ...(window !== undefined ? {
        contextWindowTokens: window,
        percentage: Number((usedTokens / window * 100).toFixed(1)),
      } : {}),
      ...(manifest.hardLimitTokens !== undefined ? { hardLimitTokens: manifest.hardLimitTokens } : {}),
      ...(manifest.targetTokens !== undefined ? { targetTokens: manifest.targetTokens } : {}),
      source: manifest.actualInputTokens !== undefined ? 'provider' : manifest.tokenSource,
      timing: manifest.actualInputTokens !== undefined ? 'last_request' : 'next_request',
      asOfTurn: manifest.turn,
      asOfAttempt: manifest.attempt,
      breakdown: manifest.breakdown,
      breakdownEstimated: true,
    };
  }
  return { source: 'unknown', timing: 'next_request' };
}

function readableStoredPresentation(presentation: Extract<SessionLedgerRecord, { type: 'tool_completed' }>['presentation']) {
  if (!presentation.rawOutput) return presentation;
  let value: unknown = presentation.rawOutput;
  try { value = JSON.parse(presentation.rawOutput); } catch { /* already display text */ }
  const output = safeDisplayOutput(value);
  const { rawOutput: _rawOutput, ...rest } = presentation;
  return {
    ...rest,
    ...(output.text ? { rawOutput: output.text } : {}),
    ...((presentation.truncated || output.truncated) ? { truncated: true } : {}),
  };
}

function projectLedger(records: SessionLedgerRecord[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const finalMessageIds = new Set(records.flatMap((record) => (
    record.type === 'run_terminal' && record.report.finalMessageId ? [record.report.finalMessageId] : []
  )));
  const legacyFinalAssistantSeqs = new Set<number>();
  for (const terminal of records) {
    if (terminal.type !== 'run_terminal' || terminal.report.status !== 'completed' || terminal.report.finalMessageId) continue;
    const candidate = [...records].reverse().find((record) => (
      record.runId === terminal.runId
      && record.type === 'message'
      && record.message.role === 'assistant'
      && Boolean(record.message.content?.trim())
      && (!terminal.report.finalAnswer || record.message.content === terminal.report.finalAnswer)
    ));
    if (candidate?.type === 'message') legacyFinalAssistantSeqs.add(candidate.seq);
  }
  const internalContextCalls = new Set(records.flatMap((record) => record.type === 'tool_started' && record.tool === 'compact_context' ? [record.callId] : []));
  for (const record of records) {
    if (record.type === 'message') {
      const message = record.message;
      if (message.role === 'user') items.push({ id: `message-${record.seq}`, kind: 'user', content: message.content });
      if (message.role === 'assistant' && message.content?.trim()) items.push({
        id: record.messageId ?? `message-${record.seq}`,
        kind: 'assistant',
        content: message.content,
        ...(record.messageId ? { messageId: record.messageId } : {}),
        runId: record.runId,
        ...(record.turn !== undefined ? { turn: record.turn } : {}),
        ...((record.messageId && finalMessageIds.has(record.messageId)) || legacyFinalAssistantSeqs.has(record.seq) ? { final: true } : {}),
      });
    } else if (record.type === 'tool_completed') {
      if (internalContextCalls.has(record.callId)) continue;
      items.push({ id: `tool-${record.presentation.callRef}`, kind: 'tool', tool: readableStoredPresentation(record.presentation) });
    } else if (record.type === 'context_compaction_started') {
      items.push({ id: `context-${record.operationRef}`, kind: 'context', context: { operationRef: record.operationRef, status: 'running' } });
    } else if (record.type === 'context_compaction_completed') {
      const existing = items.findIndex((item) => item.kind === 'context' && item.context.operationRef === record.presentation.operationRef);
      const item = { id: `context-${record.presentation.operationRef}`, kind: 'context' as const, context: record.presentation };
      if (existing >= 0) items[existing] = item;
      else items.push(item);
    } else if (record.type === 'context_compaction_failed') {
      const existing = items.findIndex((item) => item.kind === 'context' && item.context.operationRef === record.operationRef);
      const item = { id: `context-${record.operationRef}`, kind: 'context' as const, context: { operationRef: record.operationRef, status: 'failed' as const, reason: record.reason } };
      if (existing >= 0) items[existing] = item;
      else items.push(item);
    } else if (record.type === 'approval_requested') {
      items.push({
        id: `approval-${record.approvalId}`,
        kind: 'approval',
        approvalRef: record.approvalId,
        approvalKind: 'tool',
        toolName: record.request.toolName,
        effect: record.request.effect,
        title: record.request.title,
        ...(record.request.target ? { target: record.request.target } : {}),
        reason: record.request.reason,
        fingerprint: record.request.fingerprint,
        options: record.request.options,
      });
    } else if (record.type === 'approval_resolved') {
      const existing = items.findIndex((item) => item.kind === 'approval' && item.approvalRef === record.approvalId);
      if (existing >= 0) {
        const item = items[existing];
        if (item?.kind === 'approval') items[existing] = { ...item, resolved: record.decision };
      }
    } else if (record.type === 'run_terminal' && record.report.error) {
      items.push({ id: `error-${record.seq}`, kind: 'error', title: '本次运行未完成', message: record.report.error.message });
    }
  }
  return items;
}

export function projectConversation(session: Session, options: { contextWindow?: number } = {}): ConversationViewSnapshot {
  const item = projectConversationListItem(session);
  const items = projectLedger(session.ledger ?? []).map((entry) => (
    entry.kind === 'context' && entry.context.status === 'running' && !session.activeTaskId
      ? { ...entry, context: { ...entry.context, status: 'failed' as const, reason: 'interrupted' as const } }
      : entry
  ));
  return {
    ref: item.ref,
    title: item.title,
    state: item.state,
    updatedAt: item.updatedAt,
    revision: session.revision ?? 0,
    items,
    contextUsage: contextUsage(session, options.contextWindow),
  };
}
