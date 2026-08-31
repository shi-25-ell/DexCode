import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { RunContext, RunReport, SessionScope, TaskSummary } from '../shared/types.ts';
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

const generalContext: RunContext = { scope: { kind: 'general' } };

function workspaceScope(workspaceId: string): SessionScope {
  return { kind: 'workspace', workspaceId };
}

function workspaceContext(workspaceId: string, rootPath: string): RunContext {
  return { scope: workspaceScope(workspaceId), workspace: { workspaceId, rootPath } };
}

test('Session repository commits one terminal report and preserves ledger order', async () => {
  const repository = createSessionRepository({ projectId: `test-core-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const runId = crypto.randomUUID();
    await repository.beginRun({ sessionId: session.sessionId, runId, userMessage: { role: 'user', content: 'test' }, context: generalContext });
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
    assert.deepEqual(loaded?.runReports?.[0]?.context, generalContext);
    assert.equal(loaded?.contextManifests?.at(-1)?.requestDigest, 'fnv1a-test');
    assert.deepEqual(loaded?.ledger?.map((record) => record.type), ['run_started', 'message', 'context_committed', 'message', 'run_terminal']);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Session repository durably orders approval request before its resolution', async () => {
  const repository = createSessionRepository({ projectId: `test-approval-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const runId = crypto.randomUUID();
    await repository.beginRun({ sessionId: session.sessionId, runId, userMessage: { role: 'user', content: 'write' }, context: generalContext });
    await repository.recordApprovalRequested({
      sessionId: session.sessionId,
      runId,
      approvalId: 'approval-1',
      request: {
        version: 1,
        approvalId: 'approval-1',
        toolName: 'write_file',
        effect: 'write',
        title: '批准文件修改',
        reason: '逐次批准需要批准此副作用',
        fingerprint: 'fingerprint-1',
        options: ['allow_once', 'deny'],
      },
    });
    await repository.recordApprovalResolved({ sessionId: session.sessionId, runId, approvalId: 'approval-1', decision: 'allow_once' });
    const loaded = await repository.loadSession(session.sessionId);
    assert.deepEqual(loaded?.ledger?.slice(-2).map((record) => record.type), ['approval_requested', 'approval_resolved']);
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
    await firstRepository.beginRun({ sessionId: session.sessionId, runId, userMessage: { role: 'user', content: 'test' }, context: generalContext });
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

test('Session repository isolates current pointers and listings by scope', async () => {
  const repository = createSessionRepository({ projectId: `test-scope-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  const scopeA = workspaceScope('workspace-a');
  const scopeB = workspaceScope('workspace-b');
  try {
    const [sessionA, sessionB, general] = await Promise.all([
      repository.createSession(scopeA),
      repository.createSession(scopeB),
      repository.createSession(),
    ]);
    await Promise.all([
      repository.appendMessages(sessionA.sessionId, [{ role: 'user', content: 'A' }]),
      repository.appendMessages(sessionB.sessionId, [{ role: 'user', content: 'B' }]),
      repository.appendMessages(general.sessionId, [{ role: 'user', content: 'general' }]),
    ]);

    assert.equal((await repository.getCurrentSession(scopeA))?.sessionId, sessionA.sessionId);
    assert.equal((await repository.getCurrentSession(scopeB))?.sessionId, sessionB.sessionId);
    assert.equal((await repository.getCurrentSession())?.sessionId, general.sessionId);
    assert.deepEqual((await repository.listSessions(scopeA)).map((session) => session.sessionId), [sessionA.sessionId]);
    assert.deepEqual((await repository.listSessions(scopeB)).map((session) => session.sessionId), [sessionB.sessionId]);
    await assert.rejects(
      () => repository.switchSession(sessionA.sessionId, scopeB),
      /does not belong to the active workspace/,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('reading an empty workspace current Session does not materialize a conversation', async () => {
  const repository = createSessionRepository({ projectId: `test-lazy-session-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  const scope = workspaceScope('workspace-lazy');
  try {
    const current = await repository.getCurrentSession(scope);
    assert.equal(current, null);
    assert.equal((await repository.listSessions(scope)).length, 0);

    const pending = await repository.createSession(scope);
    assert.equal(await repository.getCurrentSession(scope), null);
    assert.equal((await repository.listSessions(scope)).length, 0);

    await repository.beginRun({
      sessionId: pending.sessionId,
      runId: 'run-first-interaction',
      userMessage: { role: 'user', content: 'hello' },
      context: workspaceContext('workspace-lazy', 'D:\\workspace-lazy'),
    });
    assert.equal((await repository.getCurrentSession(scope))?.sessionId, pending.sessionId);
    assert.deepEqual((await repository.listSessions(scope)).map((session) => session.sessionId), [pending.sessionId]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Session repository rejects a Run whose workspace differs from its Session scope', async () => {
  const repository = createSessionRepository({ projectId: `test-run-scope-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  const scope = workspaceScope('workspace-a');
  try {
    const session = await repository.createSession(scope);
    await assert.rejects(
      () => repository.beginRun({
        sessionId: session.sessionId,
        runId: 'run-wrong',
        userMessage: { role: 'user', content: 'test' },
        context: workspaceContext('workspace-b', 'D:\\workspace-b'),
      }),
      /does not match Session scope/,
    );

    await repository.beginRun({
      sessionId: session.sessionId,
      runId: 'run-correct',
      userMessage: { role: 'user', content: 'test' },
      context: workspaceContext('workspace-a', 'D:\\workspace-a'),
    });
    const loaded = await repository.loadSession(session.sessionId);
    const started = loaded?.ledger?.find((record) => record.type === 'run_started');
    assert.deepEqual(started && 'context' in started ? started.context : undefined, workspaceContext('workspace-a', 'D:\\workspace-a'));
    await assert.rejects(() => repository.deleteSession(session.sessionId), /active Run/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('legacy Sessions without a scope migrate conservatively to general', async () => {
  const repository = createSessionRepository({ projectId: `test-legacy-scope-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  const sessionId = 'session-legacy';
  try {
    await mkdir(repository.sessionsDir, { recursive: true });
    await writeFile(join(repository.sessionsDir, `${sessionId}.json`), JSON.stringify({
      sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: 'user', content: 'legacy' }],
      taskSummaries: [],
      activeTaskId: null,
    }), 'utf8');
    const loaded = await repository.loadSession(sessionId);
    assert.deepEqual(loaded?.scope, { kind: 'general' });
    assert.equal((await repository.listSessions({ kind: 'general' })).length, 1);
    assert.equal((await repository.listSessions(workspaceScope('workspace-a'))).length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('project memory is isolated by workspace identity', async () => {
  const repository = createSessionRepository({ projectId: `test-memory-scope-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    await repository.writeProjectMemory('memory-a', 'workspace-a');
    await repository.writeProjectMemory('memory-b', 'workspace-b');
    assert.equal(await repository.readProjectMemory('workspace-a'), 'memory-a\n');
    assert.equal(await repository.readProjectMemory('workspace-b'), 'memory-b\n');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('first submitted prompt materializes one titled Session idempotently', async () => {
  const repository = createSessionRepository({ projectId: `test-materialize-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const first = await repository.materializeRun({
      scope: { kind: 'general' },
      clientRequestId: 'request-1',
      runId: 'run-1',
      userMessage: { role: 'user', content: '  请分析当前项目的问题  ' },
      context: generalContext,
    });
    const retry = await repository.materializeRun({
      scope: { kind: 'general' },
      clientRequestId: 'request-1',
      runId: 'run-2',
      userMessage: { role: 'user', content: '不应创建第二个会话' },
      context: generalContext,
    });
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.session.sessionId, first.session.sessionId);
    assert.equal(first.session.title, '请分析当前项目的问题');
    assert.deepEqual(first.session.ledger?.map((record) => record.type), ['run_started', 'message']);
    assert.equal((await repository.listSessions({ kind: 'general' })).length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('a follow-up Run persists its client request key for retry replay', async () => {
  const repository = createSessionRepository({ projectId: `test-follow-up-idempotency-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.beginRun({
      sessionId: session.sessionId,
      runId: 'run-follow-up',
      clientRequestId: 'request-follow-up',
      userMessage: { role: 'user', content: '继续分析' },
      context: generalContext,
    });
    const loaded = await repository.loadSession(session.sessionId);
    assert.deepEqual(loaded?.clientRequestIds, ['request-follow-up']);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('context artifacts are Session scoped, digest idempotent and readable after restart', async () => {
  const projectId = `test-context-artifact-${crypto.randomUUID()}`;
  const repository = createSessionRepository({ projectId });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const other = await repository.createSession();
    await repository.beginRun({ sessionId: session.sessionId, runId: 'run-artifact', userMessage: { role: 'user', content: 'large output' }, context: generalContext });
    const content = '0123456789'.repeat(2_000);
    const first = await repository.putContextArtifact({ sessionId: session.sessionId, runId: 'run-artifact', kind: 'tool-result', sourceRef: 'call-1', content });
    const duplicate = await repository.putContextArtifact({ sessionId: session.sessionId, runId: 'run-artifact', kind: 'tool-result', sourceRef: 'call-retry', content });
    assert.equal(duplicate.id, first.id);
    const page = await repository.readContextArtifact({ sessionId: session.sessionId, ref: first.id, offset: 100, limit: 400 });
    assert.equal(page.content, content.slice(100, 500));
    assert.equal(page.nextOffset, 500);
    await assert.rejects(() => repository.readContextArtifact({ sessionId: other.sessionId, ref: first.id }), /invalid for this Session/);
    await assert.rejects(() => repository.readContextArtifact({ sessionId: session.sessionId, ref: '../forged' }), /invalid for this Session/);

    const reopened = createSessionRepository({ projectId });
    const restored = await reopened.readContextArtifact({ sessionId: session.sessionId, ref: first.id, limit: 20 });
    assert.equal(restored.content, content.slice(0, 20));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Queue mutations are durable, revisioned and idempotent', async () => {
  const repository = createSessionRepository({ projectId: `test-queue-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const runId = 'run-queue';
    await repository.beginRun({ sessionId: session.sessionId, runId, userMessage: { role: 'user', content: 'start' }, context: generalContext });
    const first = await repository.enqueueQueueItem({ sessionId: session.sessionId, content: 'queued', delivery: 'next_run', operationId: 'enqueue-1' });
    const replay = await repository.enqueueQueueItem({ sessionId: session.sessionId, content: 'ignored retry body', delivery: 'next_run', operationId: 'enqueue-1' });
    assert.equal(replay.item.itemId, first.item.itemId);
    assert.equal(replay.replayed, true);
    assert.equal((await repository.loadSession(session.sessionId))?.messages.some((message) => message.role === 'user' && message.content === 'queued'), false);
    const promoted = await repository.promoteQueueItem({ sessionId: session.sessionId, itemId: first.item.itemId, expectedRunId: runId, operationId: 'promote-1' });
    assert.equal(promoted.outcome, 'steered');
    const consumed = await repository.consumeSteer({ sessionId: session.sessionId, runId, operationId: 'consume-1' });
    assert.equal(consumed?.message.content, 'queued');
    assert.equal((await repository.getQueue(session.sessionId)).pending.length, 0);
    const cancelled = await repository.cancelQueueItem({ sessionId: session.sessionId, itemId: first.item.itemId, operationId: 'cancel-after-consume' });
    assert.equal(cancelled.outcome, 'already_consumed');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('beginRunFromQueue atomically starts a new Run and consumes one FIFO item', async () => {
  const repository = createSessionRepository({ projectId: `test-queue-run-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const first = await repository.enqueueQueueItem({ sessionId: session.sessionId, content: 'first', delivery: 'next_run', operationId: 'enqueue-first' });
    await repository.enqueueQueueItem({ sessionId: session.sessionId, content: 'second', delivery: 'next_run', operationId: 'enqueue-second' });
    const claimed = await repository.beginRunFromQueue({ sessionId: session.sessionId, runId: 'run-from-queue', context: generalContext, operationId: 'claim-first' });
    assert.equal(claimed?.item.itemId, first.item.itemId);
    assert.equal(claimed?.session.activeTaskId, 'run-from-queue');
    assert.equal(claimed?.session.messages.at(-1)?.role, 'user');
    assert.equal(claimed?.session.messages.at(-1)?.content, 'first');
    assert.deepEqual((await repository.getQueue(session.sessionId)).pending.map((item) => item.content), ['second']);
    assert.deepEqual(claimed?.session.ledger?.slice(-4).map((record) => record.type), ['run_started', 'message', 'queue_consumed', 'queue_chain_resumed']);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('recovery requeues orphaned Steer and pauses pending Queue exactly once', async () => {
  const projectId = `test-queue-recovery-${crypto.randomUUID()}`;
  const firstRepository = createSessionRepository({ projectId });
  const projectDir = dirname(firstRepository.sessionsDir);
  try {
    const session = await firstRepository.createSession();
    await firstRepository.beginRun({ sessionId: session.sessionId, runId: 'run-recovery', userMessage: { role: 'user', content: 'start' }, context: generalContext });
    await firstRepository.enqueueQueueItem({ sessionId: session.sessionId, content: 'steer me', delivery: 'steer', targetRunId: 'run-recovery', operationId: 'enqueue-steer' });
    const reopened = createSessionRepository({ projectId });
    const recovered = await reopened.loadSession(session.sessionId);
    const queue = await reopened.getQueue(session.sessionId);
    assert.equal(recovered?.activeTaskId, null);
    assert.equal(queue.pending[0]?.delivery, 'next_run');
    assert.equal(queue.paused, true);
    const requeueCount = recovered?.ledger?.filter((record) => record.type === 'queue_requeued').length;
    await reopened.loadSession(session.sessionId);
    assert.equal((await reopened.loadSession(session.sessionId))?.ledger?.filter((record) => record.type === 'queue_requeued').length, requeueCount);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
