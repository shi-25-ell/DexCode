import { describe, expect, it } from 'vitest';
import type { RunEventEnvelope, RunEventPayload } from '../../../../packages/run-protocol/contracts';
import type { ConversationViewSnapshot } from '../../../../packages/conversation-view/contracts';
import type { ConversationSnapshot } from '../types';
import { beginRunPresentation, draftReasoning, draftText, hydrateRunPresentation, reduceRunEvent } from './run-presentation';

const at = '2026-08-31T00:00:00.000Z';
const snapshot: ConversationSnapshot = {
  ref: 'session-1',
  title: '会话',
  state: 'idle',
  updatedAt: at,
  revision: 1,
  queuedItems: [],
  queuePaused: false,
  items: [{ id: 'user-1', kind: 'user', content: 'hello' }],
  contextUsage: { source: 'unknown', timing: 'next_request' },
};

function envelope(seq: number, event: RunEventPayload, eventAt = at): RunEventEnvelope {
  return { version: 2, runId: 'run-1', seq, at: eventAt, event };
}

function started() {
  let state = hydrateRunPresentation(snapshot);
  state = reduceRunEvent(state, envelope(1, { type: 'run_started', sessionId: 'session-1' }));
  state = reduceRunEvent(state, envelope(2, { type: 'assistant_message_started', turn: 1, messageId: 'message-1' }));
  return state;
}

describe('RunPresentation', () => {
  it('routes reasoning and text deltas into bounded draft blocks outside committed items', () => {
    let state = started();
    state = reduceRunEvent(state, envelope(3, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 0, kind: 'reasoning', delta: 'think' }));
    state = reduceRunEvent(state, envelope(4, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 1, kind: 'text', delta: 'answer' }));
    expect(state.committedItems).toEqual(snapshot.items);
    expect(draftReasoning(state.activeRun?.assistantDraft ?? null)?.content).toBe('think');
    expect(draftText(state.activeRun?.assistantDraft ?? null)).toBe('answer');
  });

  it('resumes the reasoning timer when reasoning output continues', () => {
    let state = started();
    state = reduceRunEvent(state, envelope(3, { type: 'run_phase_changed', phase: 'thinking' }));
    state = reduceRunEvent(state, envelope(4, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 0, kind: 'reasoning', delta: 'think' }));
    state = reduceRunEvent(state, envelope(5, { type: 'run_phase_changed', phase: 'answering' }));
    expect(state.activeRun?.reasoningCompletedAt).toBe(at);

    state = reduceRunEvent(state, envelope(6, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 0, kind: 'reasoning', delta: ' more' }));
    expect(state.activeRun?.reasoningCompletedAt).toBeUndefined();
    expect(draftReasoning(state.activeRun?.assistantDraft ?? null)?.content).toBe('think more');
  });

  it('starts a fresh reasoning timer for each assistant message', () => {
    const firstReasoningAt = '2026-08-31T00:00:01.000Z';
    const secondReasoningAt = '2026-08-31T00:00:10.000Z';
    let state = started();
    state = reduceRunEvent(state, envelope(3, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 0, kind: 'reasoning', delta: 'first' }, firstReasoningAt));
    state = reduceRunEvent(state, envelope(4, { type: 'assistant_message_started', turn: 2, messageId: 'message-2' }));
    expect(state.activeRun?.reasoningStartedAt).toBeUndefined();

    state = reduceRunEvent(state, envelope(5, { type: 'assistant_content_delta', messageId: 'message-2', contentIndex: 0, kind: 'reasoning', delta: 'second' }, secondReasoningAt));
    expect(state.activeRun?.reasoningStartedAt).toBe(secondReasoningAt);
  });

  it('clears a streamed draft before an output-limit retry', () => {
    let state = started();
    state = reduceRunEvent(state, envelope(3, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 0, kind: 'reasoning', delta: 'discarded reasoning' }));
    state = reduceRunEvent(state, envelope(4, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 1, kind: 'text', delta: 'discarded' }));
    state = reduceRunEvent(state, envelope(5, { type: 'assistant_message_reset', messageId: 'message-1' }));
    expect(draftText(state.activeRun?.assistantDraft ?? null)).toBe('');
    expect(state.activeRun?.reasoningStartedAt).toBeUndefined();
    expect(state.activeRun?.reasoningCompletedAt).toBeUndefined();
  });

  it('uses a complete committed message to repair missing deltas without ending a tool Run', () => {
    let state = started();
    state = reduceRunEvent(state, envelope(3, {
      type: 'assistant_message_committed',
      turn: 1,
      message: {
        messageId: 'message-1',
        turn: 1,
        content: 'I will inspect',
        contentBlocks: [{ contentIndex: 1, kind: 'text', content: 'I will inspect' }],
        toolCalls: [{ contentIndex: 2, callId: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
        finishReason: 'tool_calls',
      },
    }));
    expect(state.activeRun).not.toBeNull();
    expect(state.status).toBe('running');
    expect(state.activeRun?.committedMessages).toMatchObject([{ id: 'message-1', content: 'I will inspect' }]);
    expect(state.finalMessageId).toBeUndefined();
  });

  it('updates one Tool Card and one approval in place', () => {
    let state = started();
    const runningTool = { callRef: 'call-1', toolName: 'read_file', category: 'read' as const, name: '读取文件', status: 'queued' as const, summary: '准备执行' };
    state = reduceRunEvent(state, envelope(3, { type: 'tool_started', callId: 'call-1', presentation: runningTool }));
    state = reduceRunEvent(state, envelope(4, { type: 'tool_progress', callId: 'call-1', presentation: { ...runningTool, status: 'running', summary: '正在执行' } }));
    state = reduceRunEvent(state, envelope(5, { type: 'tool_finished', callId: 'call-1', presentation: { ...runningTool, status: 'succeeded', summary: '完成' } }));
    state = reduceRunEvent(state, envelope(6, { type: 'approval_requested', request: { kind: 'question', approvalId: 'approval-1', title: '继续吗？', options: ['继续', '停止'] } }));
    state = reduceRunEvent(state, envelope(7, { type: 'approval_resolved', approvalId: 'approval-1', decision: '继续' }));
    expect(Object.keys(state.activeRun?.toolsByCallId ?? {})).toEqual(['call-1']);
    expect(state.activeRun?.toolsByCallId['call-1']?.status).toBe('succeeded');
    expect(Object.keys(state.activeRun?.approvalsById ?? {})).toEqual(['approval-1']);
    expect(state.activeRun?.approvalsById['approval-1']?.resolved).toBe('继续');
    expect(state.activeRun?.activityOrder).toEqual([
      { kind: 'assistant', messageId: 'message-1' },
      { kind: 'tool', callId: 'call-1' },
      { kind: 'approval', approvalId: 'approval-1' },
    ]);
  });

  it('never creates a new activity member from progress or finish', () => {
    let state = started();
    const stray = { callRef: 'stray', toolName: 'read_file', category: 'read' as const, name: '读取文件', status: 'running' as const, summary: '正在执行' };
    state = reduceRunEvent(state, envelope(3, { type: 'tool_progress', callId: 'stray', presentation: stray }));
    expect(state.activeRun?.activityOrder).toEqual([{ kind: 'assistant', messageId: 'message-1' }]);
    expect(state.activeRun?.toolsByCallId.stray).toBeUndefined();
    expect(state.needsResync).toBe(true);
  });

  it('anchors a started child run at the exact orchestration call', () => {
    let state = started();
    state = reduceRunEvent(state, envelope(3, {
      type: 'agent_invocation_started',
      callId: 'spawn-1',
      agentId: 'agent-a',
      agentRunId: 'agent-run-a',
      turn: 1,
    }));
    expect(state.activeRun?.activityOrder).toEqual([
      { kind: 'assistant', messageId: 'message-1' },
      { kind: 'agent', callId: 'spawn-1', agentId: 'agent-a', agentRunId: 'agent-run-a', turn: 1 },
    ]);
  });

  it('marks seq gaps for resync, ignores missing deltas, and accepts authoritative commit', () => {
    let state = started();
    state = reduceRunEvent(state, envelope(4, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 1, kind: 'text', delta: 'incomplete' }));
    expect(state.needsResync).toBe(true);
    expect(draftText(state.activeRun?.assistantDraft ?? null)).toBe('');
    state = reduceRunEvent(state, envelope(5, {
      type: 'assistant_message_committed',
      turn: 1,
      message: { messageId: 'message-1', turn: 1, content: 'complete', contentBlocks: [{ contentIndex: 1, kind: 'text', content: 'complete' }], toolCalls: [], finishReason: 'stop' },
    }));
    expect(draftText(state.activeRun?.assistantDraft ?? null)).toBe('complete');
  });

  it('atomically replaces optimistic and live state with the terminal snapshot', () => {
    let state = beginRunPresentation(hydrateRunPresentation(snapshot), { content: 'next', clientRequestId: 'request-1', at });
    state = reduceRunEvent(state, envelope(1, { type: 'run_started', sessionId: 'session-1' }));
    const terminalSnapshot: ConversationViewSnapshot = {
      ref: snapshot.ref,
      title: snapshot.title,
      state: 'idle',
      updatedAt: snapshot.updatedAt,
      revision: 9,
      queuedItems: [],
      queuePaused: false,
      items: [
        { id: 'user-1', kind: 'user', content: 'hello' },
        { id: 'message-final', kind: 'assistant', content: 'final', messageId: 'message-final', final: true },
      ],
      contextUsage: snapshot.contextUsage,
    };
    state = reduceRunEvent(state, envelope(2, {
      type: 'run_finished',
      terminal: { status: 'completed', reason: 'natural_completion' },
      conversationRevision: 9,
      finalMessageId: 'message-final',
      conversation: terminalSnapshot,
    }));
    expect(state.activeRun).toBeNull();
    expect(state.committedItems).toEqual(terminalSnapshot.items);
    expect(state.revision).toBe(9);
    expect(state.status).toBe('idle');
    expect(state.needsResync).toBe(false);
    expect(reduceRunEvent(state, envelope(2, {
      type: 'run_finished', terminal: { status: 'completed', reason: 'natural_completion' }, conversationRevision: 9, finalMessageId: 'message-final', conversation: terminalSnapshot,
    }))).toBe(state);
  });

  it('keeps interrupted hydration truthful and never restores reasoning into long-term history', () => {
    const interrupted = hydrateRunPresentation({ ...snapshot, state: 'running' });
    expect(interrupted.status).toBe('failed');
    expect(interrupted.committedItems.at(-1)).toMatchObject({ kind: 'error', title: '上次运行已中断' });
    expect(JSON.stringify(interrupted.committedItems)).not.toContain('reasoning');
  });

  it('hydrates an authoritative background Main Run without reporting a recovered interruption', () => {
    const active = hydrateRunPresentation({
      ...snapshot,
      state: 'running',
      activeRun: { runId: 'background-run-1', phase: 'running' },
    });
    expect(active.status).toBe('running');
    expect(active.activeRun?.runId).toBe('background-run-1');
    expect(active.committedItems.some((item) => item.kind === 'error' && item.id === 'interrupted-live-run')).toBe(false);
  });

  it.each(['aborted', 'failed', 'limited'] as const)('uses the authoritative snapshot for a %s terminal without inventing success', (status) => {
    let state = started();
    state = reduceRunEvent(state, envelope(3, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 0, kind: 'reasoning', delta: 'ephemeral' }));
    const terminalSnapshot: ConversationViewSnapshot = {
      ref: snapshot.ref,
      title: snapshot.title,
      state: 'failed',
      updatedAt: snapshot.updatedAt,
      revision: 3,
      queuedItems: [],
      queuePaused: true,
      items: [
        { id: 'user-1', kind: 'user', content: 'hello' },
        { id: 'partial', kind: 'assistant', content: '可确认的部分结果', messageId: 'partial' },
        { id: 'error', kind: 'error', title: '本次运行未完成', message: status },
      ],
      contextUsage: snapshot.contextUsage,
    };
    state = reduceRunEvent(state, envelope(4, {
      type: 'run_finished',
      terminal: { status, reason: `test_${status}` },
      conversationRevision: terminalSnapshot.revision,
      conversation: terminalSnapshot,
    }));
    expect(state.activeRun).toBeNull();
    expect(state.status).toBe('failed');
    expect(state.terminal?.status).toBe(status);
    expect(state.committedItems).toEqual(terminalSnapshot.items);
    expect(JSON.stringify(state.committedItems)).not.toContain('ephemeral');
  });

  it('bounds reasoning and tool progress display buffers and marks truncation', () => {
    let state = started();
    state = reduceRunEvent(state, envelope(3, { type: 'assistant_content_delta', messageId: 'message-1', contentIndex: 0, kind: 'reasoning', delta: 'r'.repeat(70_000) }));
    const queued = { callRef: 'call-1', toolName: 'run_command', category: 'command' as const, name: '运行命令', status: 'queued' as const, summary: '准备中' };
    state = reduceRunEvent(state, envelope(4, { type: 'tool_started', callId: 'call-1', presentation: queued }));
    state = reduceRunEvent(state, envelope(5, { type: 'tool_progress', callId: 'call-1', presentation: { ...queued, status: 'running', rawOutput: 'o'.repeat(40_000) } }));
    expect(draftReasoning(state.activeRun?.assistantDraft ?? null)).toMatchObject({ truncated: true });
    expect(draftReasoning(state.activeRun?.assistantDraft ?? null)?.content).toHaveLength(64_000);
    expect(state.activeRun?.toolsByCallId['call-1']?.rawOutput).toHaveLength(32_000);
    expect(state.activeRun?.toolsByCallId['call-1']?.truncated).toBe(true);
  });

  it('starts the next queued Run with a fresh per-Run sequence after the previous terminal', () => {
    let state = started();
    const terminalConversation: ConversationViewSnapshot = {
      ref: snapshot.ref,
      title: snapshot.title,
      state: 'idle',
      updatedAt: snapshot.updatedAt,
      revision: 2,
      queuedItems: [],
      queuePaused: false,
      items: [{ id: 'user-1', kind: 'user', content: 'hello' }],
      contextUsage: snapshot.contextUsage,
    };
    state = reduceRunEvent(state, envelope(3, {
      type: 'run_finished',
      terminal: { status: 'completed', reason: 'natural_completion' },
      conversationRevision: 2,
      conversation: terminalConversation,
    }));
    const next: RunEventEnvelope = {
      version: 2,
      runId: 'run-2',
      seq: 1,
      at,
      event: { type: 'run_started', sessionId: snapshot.ref, sourceItemId: 'queue-1' },
    };
    state = reduceRunEvent(state, next);
    expect(state.activeRun?.runId).toBe('run-2');
    expect(state.lastSeq).toBe(1);
    expect(state.terminal).toBeUndefined();
  });
});
