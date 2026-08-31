import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEventEnvelope, RunEventPayload } from '../../../packages/run-protocol/contracts';
import { streamConversation } from './api';

const at = '2026-08-31T00:00:00.000Z';

function event(seq: number, payload: RunEventPayload): RunEventEnvelope {
  return { version: 2, runId: 'run-1', seq, at, event: payload };
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]![1] as RequestInit;
    const second = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(new Headers(first.headers).get('X-DexCode-Stream-Version')).toBe('2');
    expect(JSON.parse(String(first.body))).toMatchObject({ clientRequestId: 'request-1', afterSeq: 0 });
    expect(JSON.parse(String(second.body))).toMatchObject({ clientRequestId: 'request-1', afterSeq: 2 });
  });
});
