import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import type { RunReport, TaskSummary } from '../shared/types.ts';
import { createSessionRepository } from './index.ts';

function terminal(runId: string): { report: RunReport; summary: TaskSummary } {
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  return {
    report: {
      version: 1,
      runId,
      status: 'completed',
      terminationReason: 'natural_completion',
      finalAnswer: 'done',
      startedAt,
      completedAt,
      modelTurnCount: 1,
      modelAttemptCount: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, unknown: 0 },
      toolsUsed: [],
      filesModified: [],
    },
    summary: {
      taskId: runId,
      prompt: 'test',
      startedAt,
      completedAt,
      status: 'completed',
      summary: 'done',
      toolsUsed: [],
      filesModified: [],
    },
  };
}

test('Session repository commits one terminal report and preserves ledger order', async () => {
  const repository = createSessionRepository({ projectId: `test-core-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const runId = crypto.randomUUID();
    await repository.beginRun({ sessionId: session.sessionId, runId, userMessage: { role: 'user', content: 'test' } });
    await repository.commitContext({
      sessionId: session.sessionId,
      runId,
      manifest: {
        version: 1,
        id: 'manifest-1',
        runId,
        estimatedInputTokens: 12,
        selectedMessageCount: 1,
        omittedMessageCount: 0,
        requestDigest: 'fnv1a-test',
      },
    });
    await repository.appendRunMessage({ sessionId: session.sessionId, runId, message: { role: 'assistant', content: 'done' } });
    const terminalValue = terminal(runId);
    const first = await repository.finishRun({ sessionId: session.sessionId, ...terminalValue });
    const second = await repository.finishRun({ sessionId: session.sessionId, ...terminalValue });
    assert.equal(first.committed, true);
    assert.equal(second.committed, false);
    const loaded = await repository.loadSession(session.sessionId);
    assert.equal(loaded?.activeTaskId, null);
    assert.equal(loaded?.runReports?.length, 1);
    assert.equal(loaded?.contextManifests?.at(-1)?.requestDigest, 'fnv1a-test');
    assert.deepEqual(loaded?.ledger?.map((record) => record.type), ['run_started', 'message', 'context_committed', 'message', 'run_terminal']);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('a new repository instance recovers an interrupted Run exactly once', async () => {
  const projectId = `test-recovery-${crypto.randomUUID()}`;
  const firstRepository = createSessionRepository({ projectId });
  const projectDir = dirname(firstRepository.sessionsDir);
  try {
    const session = await firstRepository.createSession();
    const runId = crypto.randomUUID();
    await firstRepository.beginRun({ sessionId: session.sessionId, runId, userMessage: { role: 'user', content: 'test' } });
    const reopened = createSessionRepository({ projectId });
    const recovered = await reopened.loadSession(session.sessionId);
    const loadedAgain = await reopened.loadSession(session.sessionId);
    assert.equal(recovered?.activeTaskId, null);
    assert.equal(recovered?.runReports?.at(-1)?.terminationReason, 'recovered_interruption');
    assert.equal(loadedAgain?.runReports?.length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
