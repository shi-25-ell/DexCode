import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEventEnvelope, RunEventPayload } from '../../../packages/run-protocol/contracts';
import { streamConversation, streamExistingConversationRun } from './api';

const at = '2026-08-31T00:00:00.000Z';

function event(seq: number, payload: RunEventPayload, runId = 'run-1'): RunEventEnvelope {
  return { version: 2, runId, seq, at, event: payload };
}

function stream(events: RunEventEnvelope[]): Response {
  return new Response(events.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('streamConversation', () => {
  it('negotiates V2 and resumes afterSeq without redelivering a received event', async () => {
    const terminalConversation = {
      ref: 'session-1', title: '会话', state: 'idle' as const, updatedAt: at, revision: 2,
      queuedItems: [], queuePaused: false,
      items: [{ id: 'message-1', kind: 'assistant' as const, content: '完成', messageId: 'message-1', final: true }],
      contextUsage: { source: 'unknown' as const, timing: 'next_request' as const },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(stream([
        event(1, { type: 'run_started', sessionId: 'session-1', isNew: true }),
        event(2, { type: 'run_phase_changed', phase: 'requesting_model' }),
      ]))
      .mockResolvedValueOnce(stream([
        event(2, { type: 'run_phase_changed', phase: 'requesting_model' }),
        event(3, {
          type: 'run_finished', terminal: { status: 'completed', reason: 'natural_completion' },
          conversationRevision: 2, finalMessageId: 'message-1', conversation: terminalConversation,
        }),
      ]))
      .mockResolvedValueOnce(stream([
        event(3, {
          type: 'run_finished', terminal: { status: 'completed', reason: 'natural_completion' },
          conversationRevision: 2, finalMessageId: 'message-1', conversation: terminalConversation,
        }),
      ]));
    const delivered: number[] = [];
    const result = await streamConversation({
      scope: { kind: 'general' },
      clientRequestId: 'request-1',
      prompt: '继续',
      signal: new AbortController().signal,
      onEvent: (envelope) => delivered.push(envelope.seq),
    });

    expect(delivered).toEqual([1, 2, 3]);
    expect(result).toEqual({ lastSeq: 3, runId: 'run-1', terminal: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const first = fetchMock.mock.calls[0]![1] as RequestInit;
    const second = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(new Headers(first.headers).get('X-DexCode-Stream-Version')).toBe('2');
    expect(JSON.parse(String(first.body))).toMatchObject({ clientRequestId: 'request-1', afterSeq: 0 });
    expect(JSON.parse(String(second.body))).toMatchObject({ clientRequestId: 'request-1', afterSeq: 2 });
    const third = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(JSON.parse(String(third.body))).toMatchObject({ clientRequestId: 'request-1', afterSeq: 3 });
  });

  it('tracks seq independently across a queued Run chain and probes the final terminal once', async () => {
    const conversation = {
      ref: 'session-chain', title: '链式会话', state: 'idle' as const, updatedAt: at, revision: 4,
      queuedItems: [], queuePaused: false, items: [],
      contextUsage: { source: 'unknown' as const, timing: 'next_request' as const },
    };
    const terminal = (runId: string) => event(2, {
      type: 'run_finished', terminal: { status: 'completed', reason: 'natural_completion' },
      conversationRevision: 4, conversation,
    }, runId);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(stream([
        event(1, { type: 'run_started', sessionId: conversation.ref }, 'run-a'),
        terminal('run-a'),
      ]))
      .mockResolvedValueOnce(stream([
        terminal('run-a'),
        event(1, { type: 'run_started', sessionId: conversation.ref, sourceItemId: 'queue-1' }, 'run-b'),
        terminal('run-b'),
      ]))
      .mockResolvedValueOnce(stream([terminal('run-b')]));
    const delivered: string[] = [];
    const result = await streamConversation({
      scope: { kind: 'general' },
      conversationRef: conversation.ref,
      clientRequestId: 'request-chain',
      prompt: 'start chain',
      signal: new AbortController().signal,
      onEvent: (envelope) => delivered.push(`${envelope.runId}:${envelope.seq}`),
    });
    expect(delivered).toEqual(['run-a:1', 'run-a:2', 'run-b:1', 'run-b:2']);
    expect(result).toEqual({ lastSeq: 2, runId: 'run-b', terminal: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toMatchObject({ afterSeq: 2 });
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body))).toMatchObject({ afterSeq: 2 });
  });
});

describe('streamExistingConversationRun', () => {
  it('attaches to a server-started Run by runId and forwards replayed events', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(stream([
      event(1, { type: 'run_started', sessionId: 'session-1' }, 'background-run'),
      event(2, { type: 'run_phase_changed', phase: 'requesting_model' }, 'background-run'),
      event(3, {
        type: 'run_finished', terminal: { status: 'completed', reason: 'natural_completion' }, conversationRevision: 2,
        conversation: { ref: 'session-1', title: '会话', state: 'idle', updatedAt: at, revision: 2, queuedItems: [], queuePaused: false, items: [], contextUsage: { source: 'unknown', timing: 'next_request' } },
      }, 'background-run'),
    ]));
    const delivered: number[] = [];
    await streamExistingConversationRun({
      scope: { kind: 'workspace', workspaceRef: 'workspace-1' },
      runId: 'background-run',
      signal: new AbortController().signal,
      onEvent: (envelope) => delivered.push(envelope.seq),
    });
    expect(delivered).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversation-runs/background-run/events?afterSeq=0&scope=workspace&workspaceRef=workspace-1',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Workspace-Ref': 'workspace-1' }) }),
    );
  });
});
