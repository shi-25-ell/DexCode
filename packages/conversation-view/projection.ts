import type { Session, SessionLedgerRecord, ToolPresentation } from '../shared/types.ts';
import type { AgentTreeSnapshotView, ConversationItem, ConversationListItem, ConversationState, ConversationViewSnapshot, ContextUsageView } from './contracts.ts';
import { safeDisplayOutput } from './output-policy.ts';
import { presentTool } from './tool-presentation.ts';
import { conversationTitle } from './title.ts';
import { projectQueue } from '../agent-core/queue-reducer.ts';
import { batchToolSequence } from './tool-batching.ts';

function sessionState(session: Session): ConversationState {
  if (session.activeTaskId) {
    const pendingApproval = [...(session.ledger ?? [])].reverse().find((record) => record.type === 'approval_requested' || record.type === 'approval_resolved');
    return pendingApproval?.type === 'approval_requested' ? 'waiting' : 'running';
  }
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

function readableStoredPresentation(
  presentation: Extract<SessionLedgerRecord, { type: 'tool_completed' }>['presentation'],
  started?: Extract<SessionLedgerRecord, { type: 'tool_started' }>,
) {
  if (started && presentation.status === 'succeeded' && (started.tool === 'memory_upsert' || started.tool === 'memory_remove')) {
    try {
      return presentTool({
        callRef: presentation.callRef,
        tool: started.tool,
        args: started.input ?? {},
        result: { ok: true },
        status: 'succeeded',
      });
    } catch { /* keep the stored presentation if legacy input cannot be reconstructed */ }
  }
  const toolName = presentation.toolName || started?.tool || 'unknown';
  if (toolName === 'write_file' || toolName === 'patch_file') {
    const { rawOutput: _rawOutput, ...rest } = presentation;
    return { ...rest, toolName };
  }
  if (!presentation.rawOutput) return { ...presentation, toolName };
  let value: unknown = presentation.rawOutput;
  try { value = JSON.parse(presentation.rawOutput); } catch { /* already display text */ }
  const output = safeDisplayOutput(value);
  const { rawOutput: _rawOutput, ...rest } = presentation;
  return {
    ...rest,
    toolName,
    ...(output.text ? { rawOutput: output.text } : {}),
    ...((presentation.truncated || output.truncated) ? { truncated: true } : {}),
  };
}

type AgentGroup = {
  key: string;
  runs: AgentTreeSnapshotView['runs'];
  item: Extract<ConversationItem, { kind: 'agent_activity' }>;
};

function legacyDelegationGroupId(run: AgentTreeSnapshotView['runs'][number], agents: AgentTreeSnapshotView): string | undefined {
  if (run.trigger !== 'spawn') return undefined;
  return (agents.agents.find((agent) => agent.agentId === run.agentId) as { delegationGroupId?: string } | undefined)?.delegationGroupId;
}

function sourceTurn(run: AgentTreeSnapshotView['runs'][number], groupId?: string): number | undefined {
  if (Number.isInteger(run.invokedByTurn) && run.invokedByTurn! > 0) return run.invokedByTurn;
  const legacy = groupId?.match(/-(\d+)$/)?.[1];
  return legacy ? Number(legacy) : undefined;
}

function agentGroups(agents: AgentTreeSnapshotView | null): AgentGroup[] {
  if (!agents) return [];
  const groups = new Map<string, AgentTreeSnapshotView['runs']>();
  for (const run of agents.runs) {
    const key = run.delegationGroupId ?? legacyDelegationGroupId(run, agents) ?? `agent-run:${run.agentRunId}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({
    key,
    runs: group,
    item: {
      id: `agent-activity-${key}`,
      kind: 'agent_activity',
      sourceRunId: group[0]!.invokedByRunId,
      ...(key.startsWith('agent-run:') ? {} : { delegationGroupId: key }),
      agentRunIds: group.map((run) => run.agentRunId),
    },
  }));
}

function projectLedger(records: SessionLedgerRecord[], agents: AgentTreeSnapshotView | null): ConversationItem[] {
  type Boundary = ConversationItem | undefined;
  const sequence: Array<
    | { kind: 'tool'; key: string; tool: ToolPresentation }
    | { kind: 'boundary'; key: string; value: Boundary; transparentFor?: import('../shared/types.ts').ToolBatchType[] }
  > = [];
  const pushItem = (item: ConversationItem) => sequence.push({ kind: 'boundary', key: item.id, value: item });
  const breakBatch = (key: string) => sequence.push({ kind: 'boundary', key, value: undefined });
  const groups = agentGroups(agents);
  const groupsByToolCall = new Map(groups.flatMap((group) => group.runs.flatMap((run) => (
    run.invokedByToolCallId ? [[run.invokedByToolCallId, group] as const] : []
  ))));
  const placedAgentGroups = new Set<string>();
  const finalMessageIds = new Set(records.flatMap((record) => (
    record.type === 'run_terminal' && record.report.finalMessageId ? [record.report.finalMessageId] : []
  )));
  const steerMessageSeqs = new Set(records.flatMap((record, index) => {
    if (record.type !== 'queue_consumed' || record.delivery !== 'steer') return [];
    const message = records[index - 1];
    return message?.type === 'message'
      && message.runId === record.runId
      && message.message.role === 'user'
      ? [message.seq]
      : [];
  }));
  const legacyFinalAssistantSeqs = new Set<number>();
  for (const terminal of records) {
    if (terminal.type !== 'run_terminal' || terminal.report.status !== 'completed' || terminal.report.finalMessageId) continue;
    const candidate = [...records].reverse().find((record) => (
      record.type === 'message'
      && record.runId === terminal.runId
      && record.message.role === 'assistant'
      && Boolean(record.message.content?.trim())
      && (!terminal.report.finalAnswer || record.message.content === terminal.report.finalAnswer)
    ));
    if (candidate?.type === 'message') legacyFinalAssistantSeqs.add(candidate.seq);
  }
  const internalContextCalls = new Set(records.flatMap((record) => record.type === 'tool_started' && ['compact_context', 'spawn_agent', 'wait_agent', 'followup_agent', 'stop_agent'].includes(record.tool) ? [record.callId] : []));
  const completedTools = new Map(records.flatMap((record) => record.type === 'tool_completed' ? [[record.callId, record] as const] : []));
  const approvalDecisionById = new Map(records.flatMap((record) => record.type === 'approval_resolved' ? [[record.approvalId, record.decision] as const] : []));
  const commandApprovalByCall = new Map<string, { approvalId: string; decision?: string }>();
  const commandCallByApprovalId = new Map<string, string>();
  let awaitingCommandApproval: string | undefined;
  let approvalRunId: string | undefined;
  for (const record of records) {
    if ('runId' in record && record.runId !== approvalRunId) { approvalRunId = record.runId; awaitingCommandApproval = undefined; }
    if (record.type === 'tool_started') awaitingCommandApproval = record.tool === 'run_command' ? record.callId : undefined;
    else if (record.type === 'approval_requested' && awaitingCommandApproval && record.request.toolName === 'run_command') {
      const decision = approvalDecisionById.get(record.approvalId);
      commandApprovalByCall.set(awaitingCommandApproval, { approvalId: record.approvalId, ...(decision ? { decision } : {}) });
      commandCallByApprovalId.set(record.approvalId, awaitingCommandApproval);
      awaitingCommandApproval = undefined;
    } else if (record.type === 'message' && record.message.role === 'assistant') awaitingCommandApproval = undefined;
    else if (record.type === 'tool_completed') awaitingCommandApproval = undefined;
  }
  let currentRunId: string | undefined;
  for (const record of records) {
    if ('runId' in record && record.runId !== currentRunId) {
      if (currentRunId !== undefined) breakBatch(`run-boundary-${record.seq}`);
      currentRunId = record.runId;
    }
    if (record.type === 'message') {
      const message = record.message;
      if (message.role === 'user' && !record.origin?.startsWith('agent_notification:')) pushItem({
        id: `message-${record.seq}`,
        kind: 'user',
        content: message.content,
        ...(steerMessageSeqs.has(record.seq) ? { delivery: 'steer' as const } : {}),
      });
      if (message.role === 'assistant') {
        if (message.content?.trim()) pushItem({
          id: record.messageId ?? `message-${record.seq}`,
          kind: 'assistant',
          content: message.content,
          ...(record.messageId ? { messageId: record.messageId } : {}),
          runId: record.runId,
          ...(record.turn !== undefined ? { turn: record.turn } : {}),
          ...((record.messageId && finalMessageIds.has(record.messageId)) || legacyFinalAssistantSeqs.has(record.seq) ? { final: true } : {}),
        });
        else breakBatch(`assistant-boundary-${record.seq}`);
      }
    } else if (record.type === 'tool_started') {
      if (record.tool === 'spawn_agent' || record.tool === 'followup_agent') {
        const group = groupsByToolCall.get(record.callId);
        if (group && !placedAgentGroups.has(group.key)) {
          pushItem(group.item);
          placedAgentGroups.add(group.key);
        } else breakBatch(`agent-boundary-${record.seq}`);
      } else if (internalContextCalls.has(record.callId)) {
        breakBatch(`internal-tool-boundary-${record.seq}`);
      } else {
        const completed = completedTools.get(record.callId);
        if (completed) {
          const stored = readableStoredPresentation(completed.presentation, record);
          const approval = commandApprovalByCall.get(record.callId);
          const tool = record.tool === 'run_command' ? {
            ...stored,
            approval: approval ? {
              status: approval.decision === 'deny' ? 'denied' as const : approval.decision ? 'approved' as const : 'pending' as const,
              addedToWhitelist: approval.decision === 'allow_whitelist',
            } : { status: 'not_required' as const, addedToWhitelist: false },
          } : stored;
          sequence.push({ kind: 'tool', key: `tool-${tool.callRef}`, tool });
        } else breakBatch(`unfinished-tool-boundary-${record.seq}`);
      }
    } else if (record.type === 'tool_completed') {
      continue;
    } else if (record.type === 'context_compaction_started') {
      pushItem({ id: `context-${record.operationRef}`, kind: 'context', context: { operationRef: record.operationRef, status: 'running' } });
    } else if (record.type === 'context_compaction_completed') {
      if (!record.summaryRecordId && (record.presentation.summarizedMessages ?? 0) === 0) continue;
      const existing = sequence.findIndex((entry) => entry.kind === 'boundary' && entry.value?.kind === 'context' && entry.value.context.operationRef === record.presentation.operationRef);
      const item = { id: `context-${record.presentation.operationRef}`, kind: 'context' as const, context: record.presentation };
      if (existing >= 0) sequence[existing] = { kind: 'boundary', key: item.id, value: item };
      else pushItem(item);
    } else if (record.type === 'context_compaction_failed') {
      const existing = sequence.findIndex((entry) => entry.kind === 'boundary' && entry.value?.kind === 'context' && entry.value.context.operationRef === record.operationRef);
      const item = { id: `context-${record.operationRef}`, kind: 'context' as const, context: { operationRef: record.operationRef, status: 'failed' as const, reason: record.reason } };
      if (existing >= 0) sequence[existing] = { kind: 'boundary', key: item.id, value: item };
      else pushItem(item);
    } else if (record.type === 'approval_requested') {
      const item: ConversationItem = {
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
      };
      sequence.push({
        kind: 'boundary', key: item.id, value: item,
        ...(commandCallByApprovalId.has(record.approvalId) ? { transparentFor: ['command' as const] } : {}),
      });
    } else if (record.type === 'approval_resolved') {
      const existing = sequence.findIndex((entry) => entry.kind === 'boundary' && entry.value?.kind === 'approval' && entry.value.approvalRef === record.approvalId);
      if (existing >= 0) {
        const entry = sequence[existing];
        if (entry?.kind === 'boundary' && entry.value?.kind === 'approval') sequence[existing] = { ...entry, value: { ...entry.value, resolved: record.decision } };
      }
    } else if (record.type === 'context_committed' || record.type === 'context_prepare_committed' || record.type === 'context_usage_observed') {
      breakBatch(`context-boundary-${record.seq}`);
    } else if (record.type === 'run_terminal' && record.report.error) {
      pushItem({ id: `error-${record.seq}`, kind: 'error', title: '本次运行未完成', message: record.report.error.message });
    }
  }
  const items = batchToolSequence(sequence).flatMap((entry): ConversationItem[] => {
    if (entry.kind === 'boundary') return entry.value ? [entry.value] : [];
    if (entry.kind === 'tool') return [{ id: entry.key, kind: 'tool', tool: entry.tool }];
    return [{ id: entry.batch.id, kind: 'tool_batch', batch: entry.batch }];
  });
  return withAgentActivities(items, agents, placedAgentGroups);
}

function withAgentActivities(items: ConversationItem[], agents: AgentTreeSnapshotView | null, alreadyPlaced = new Set<string>()): ConversationItem[] {
  const result = [...items];
  for (const group of agentGroups(agents)) {
    if (alreadyPlaced.has(group.key)) continue;
    const sourceRunId = group.runs[0]!.invokedByRunId;
    const turn = sourceTurn(group.runs[0]!, group.item.delegationGroupId);
    let index = -1;
    for (let cursor = result.length - 1; cursor >= 0; cursor -= 1) {
      const entry = result[cursor];
      if (entry?.kind === 'assistant' && entry.runId === sourceRunId && (turn === undefined || entry.turn === turn)) { index = cursor; break; }
    }
    result.splice(index >= 0 ? index + 1 : result.length, 0, group.item);
  }
  return result;
}

export function projectConversation(session: Session, options: { contextWindow?: number; activePhase?: 'running' | 'waiting_confirm' | 'closing' | 'stopping'; agents?: AgentTreeSnapshotView | null } = {}): ConversationViewSnapshot {
  const item = projectConversationListItem(session);
  const queue = projectQueue(session.sessionId, session.ledger ?? []);
  const items = projectLedger(session.ledger ?? [], options.agents ?? null).map((entry) => (
    entry.kind === 'context' && entry.context.status === 'running' && !session.activeTaskId
      ? { ...entry, context: { ...entry.context, status: 'failed' as const, reason: 'interrupted' as const } }
      : entry
  ));
  return {
    ref: item.ref,
    title: item.title,
    state: options.activePhase === 'waiting_confirm' ? 'waiting' : item.state,
    ...(session.activeTaskId ? { activeRun: { runId: session.activeTaskId, phase: options.activePhase ?? (item.state === 'waiting' ? 'waiting_confirm' : 'running') } } : {}),
    queuedItems: queue.pending,
    queuePaused: queue.paused,
    updatedAt: item.updatedAt,
    revision: session.revision ?? 0,
    items,
    contextUsage: contextUsage(session, options.contextWindow),
    agents: options.agents ?? null,
  };
}
