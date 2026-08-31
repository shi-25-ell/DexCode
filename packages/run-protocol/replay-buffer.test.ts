import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunEventEnvelope, RunEventPayload } from './contracts.ts';
import { createRunReplayBuffer } from './replay-buffer.ts';

function envelope(runId: string, seq: number, event: RunEventPayload): RunEventEnvelope {
  return { version: 2, runId, seq, at: '2026-08-31T00:00:00.000Z', event };
}

test('bounded replay resumes after seq without duplicating delivered events', () => {
  const replay = createRunReplayBuffer({ maxEventsPerRun: 8 });
  replay.append(envelope('run-a', 1, { type: 'run_started', sessionId: 'session-a' }));
  replay.append(envelope('run-a', 2, { type: 'run_phase_changed', phase: 'requesting_model' }));
  replay.append(envelope('run-a', 3, { type: 'assistant_message_started', turn: 1, messageId: 'message-a' }));
  assert.deepEqual(replay.read('run-a', 1), {
    status: 'available',
    events: [
      envelope('run-a', 2, { type: 'run_phase_changed', phase: 'requesting_model' }),
      envelope('run-a', 3, { type: 'assistant_message_started', turn: 1, messageId: 'message-a' }),
    ],
    windowExceeded: false,
  });
});

test('bounded replay reports when the requested seq fell outside its retained window', () => {
  const replay = createRunReplayBuffer({ maxEventsPerRun: 8, maxBytesPerRun: 32_768 });
  for (let seq = 1; seq <= 12; seq += 1) {
    replay.append(envelope('run-window', seq, seq === 1
      ? { type: 'run_started', sessionId: 'session-window' }
      : { type: 'run_phase_changed', phase: 'requesting_model' }));
  }
  const result = replay.read('run-window', 0);
  assert.equal(result.status, 'available');
  if (result.status === 'available') {
    assert.equal(result.windowExceeded, true);
    assert.equal(result.events[0]?.seq, 5);
  }
});

test('bounded replay isolates concurrent runs and evicts least recently used runs', () => {
  const replay = createRunReplayBuffer({ maxRuns: 2 });
  replay.append(envelope('run-a', 1, { type: 'run_started', sessionId: 'session-a' }));
  replay.append(envelope('run-b', 1, { type: 'run_started', sessionId: 'session-b' }));
  replay.read('run-a');
  replay.append(envelope('run-c', 1, { type: 'run_started', sessionId: 'session-c' }));
  assert.equal(replay.read('run-b').status, 'missing');
  assert.equal(replay.read('run-a').status, 'available');
  assert.equal(replay.read('run-c').status, 'available');
});
