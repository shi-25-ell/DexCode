import type { AgentEvent } from '../shared/types.ts';
import type { RunEventEnvelope } from './contracts.ts';

function legacyStatus(envelope: RunEventEnvelope): AgentEvent[] {
  if (envelope.event.type !== 'run_phase_changed') return [];
  const status = envelope.event.phase === 'waiting_approval'
    ? 'waiting_confirm'
    : envelope.event.phase === 'finalizing'
      ? 'summarizing'
      : envelope.event.phase === 'preparing_context'
        ? 'planning'
        : 'executing';
  return [{ type: 'task_status', taskId: envelope.runId, status, ...(envelope.event.note ? { note: envelope.event.note } : {}) }];
}

export function runEventToLegacy(envelope: RunEventEnvelope): AgentEvent[] {
  const event = envelope.event;
  if (event.type === 'run_started') return [{ type: 'session', sessionId: event.sessionId, isNew: event.isNew ?? false }];
  if (event.type === 'run_phase_changed') return legacyStatus(envelope);
  if (event.type === 'assistant_content_delta') {
    if (event.kind === 'text') return [{ type: 'chunk', chunk: event.delta }];
    if (event.kind === 'reasoning') return [{ type: 'reasoning_chunk', chunk: event.delta }];
    return [];
  }
  if (event.type === 'tool_started') return [
    { type: 'tool_status', callId: event.callId, tool: event.presentation.name, status: 'running' },
    { type: 'tool_view', presentation: { ...event.presentation, status: 'running' } },
  ];
  if (event.type === 'tool_progress') return [{ type: 'tool_view', presentation: event.presentation }];
  if (event.type === 'tool_finished') return [
    { type: 'tool_status', callId: event.callId, tool: event.presentation.name, status: 'settled' },
    { type: 'tool_view', presentation: event.presentation },
  ];
  if (event.type === 'approval_requested') {
    const request = event.request;
    if (request.kind === 'tool') return [{
      version: 1,
      type: 'approval_request',
      taskId: envelope.runId,
      approvalId: request.approvalId,
      toolName: request.toolName,
      effect: request.effect,
      title: request.title,
      ...(request.target ? { target: request.target } : {}),
      reason: request.reason,
      fingerprint: request.fingerprint,
      options: request.options,
    }];
    if (request.kind === 'command') return [{
      type: 'command_confirm_request',
      taskId: envelope.runId,
      confirmId: request.approvalId,
      command: request.target,
      cwd: '',
      risk: 'high',
      reason: request.reason,
    }];
    return [{ type: 'confirm_request', taskId: envelope.runId, confirmId: request.approvalId, question: request.title, options: request.options }];
  }
  if (event.type === 'approval_resolved') return [{ type: 'approval_resolved', approvalId: event.approvalId, decision: event.decision as import('../shared/types.ts').ApprovalOption }];
  if (event.type === 'context_usage_changed') return [{ type: 'context_usage', ...event.usage }];
  if (event.type === 'context_activity_changed') return [{ type: 'context_activity', presentation: event.presentation }];
  if (event.type === 'skill_activity') return [{ type: 'skill', skill: event.skill, action: event.action as 'listed' | 'read' | 'activated' | 'deactivated' }];
  if (event.type === 'queue_item_added' || event.type === 'queue_item_updated') return [{ ...event }];
  if (event.type === 'queue_item_removed' || event.type === 'queue_reordered') return [{ ...event }];
  if (event.type === 'user_message_committed') return [{ ...event, runId: envelope.runId }];
  if (event.type === 'context_refresh_started' || event.type === 'context_refresh_completed' || event.type === 'context_refresh_failed') {
    return [{ ...event, runId: envelope.runId }];
  }
  if (event.type === 'run_chain_paused') return [{ ...event }];
  if (event.type === 'run_finished') return [
    {
      type: 'task_status',
      taskId: envelope.runId,
      status: event.terminal.status === 'completed' ? 'done' : event.terminal.status === 'aborted' ? 'aborted' : 'error',
      note: event.terminal.reason,
    },
    { type: 'result', result: event.legacyResult ?? { conversation: event.conversation, report: event.terminal } },
  ];
  if (event.type === 'stream_error') return [{ type: 'error', message: event.message }];
  return [];
}
