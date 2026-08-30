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

function contextUsage(session: Session, limitTokens?: number): ContextUsageView {
  const report = session.runReports?.at(-1);
  const manifest = session.contextManifests?.at(-1);
  const usedTokens = report?.latestInputTokens ?? manifest?.estimatedInputTokens;
  const source = report?.latestInputTokens !== undefined ? 'provider' : usedTokens !== undefined ? 'estimated' : 'unknown';
  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(limitTokens !== undefined ? { limitTokens } : {}),
    ...(usedTokens !== undefined && limitTokens ? { percentage: Math.min(100, Math.round(usedTokens / limitTokens * 100)) } : {}),
    source,
    ...(report ? { asOfTurn: report.modelTurnCount } : {}),
  };
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
  for (const record of records) {
    if (record.type === 'message') {
      const message = record.message;
      if (message.role === 'user') items.push({ id: `message-${record.seq}`, kind: 'user', content: message.content });
      if (message.role === 'assistant' && message.content?.trim()) items.push({ id: `message-${record.seq}`, kind: 'assistant', content: message.content });
    } else if (record.type === 'tool_completed') {
      items.push({ id: `tool-${record.presentation.callRef}`, kind: 'tool', tool: readableStoredPresentation(record.presentation) });
    } else if (record.type === 'run_terminal' && record.report.error) {
      items.push({ id: `error-${record.seq}`, kind: 'error', title: '本次运行未完成', message: record.report.error.message });
    }
  }
  return items;
}

export function projectConversation(session: Session, options: { contextWindow?: number } = {}): ConversationViewSnapshot {
  const item = projectConversationListItem(session);
  return {
    ref: item.ref,
    title: item.title,
    state: item.state,
    updatedAt: item.updatedAt,
    items: projectLedger(session.ledger ?? []),
    contextUsage: contextUsage(session, options.contextWindow),
  };
}
