import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('Session repository records a user-visible compaction only when a new summary is committed', async () => {
  const repository = createSessionRepository({ projectId: `test-context-presentation-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const breakdown = { systemPrompt: 2, workspaceCode: 0, recentConversation: 3, toolResults: 0, projectKnowledge: 0, managedMemory: 0, toolDefinitions: 1, other: 1 };
    const activity = {
      operationRef: 'context-cheap',
      layers: ['middle_archive'] as const,
      beforeTokens: 12,
      afterTokens: 10,
      beforeBreakdown: breakdown,
      afterBreakdown: breakdown,
      externalizedToolResults: 0,
      archivedMessages: 4,
      archivedConversationSegments: 2,
      compactedToolResults: 0,
      summarizedMessages: 0,
      retainedConversationSegments: 0,
      retainedMessageCount: 0,
    };
    await repository.beginRun({ sessionId: session.sessionId, runId, userMessage: { role: 'user', content: 'test' }, context: generalContext });
    await repository.commitContext({
      sessionId: session.sessionId,
      runId,
      manifest: {
        version: 2,
        id: 'manifest-cheap',
        runId,
        turn: 1,
        attempt: 1,
        createdAt: now,
        requestDigest: 'digest-cheap',
        requestSerializedChars: 40,
        estimatedInputTokens: 10,
        tokenSource: 'estimated',
        maxOutputTokens: 1_000,
        reserveTokens: 500,
        breakdown,
        layers: [...activity.layers],
        activity: { ...activity, layers: [...activity.layers] },
        artifactRefs: [],
        includedToolResultIds: [],
      },
      activity: { ...activity, layers: [...activity.layers] },
    });

    const summaryActivity = {
      ...activity,
      operationRef: 'context-summary',
      layers: ['summary'] as const,
      afterTokens: 7,
      archivedMessages: 0,
      archivedConversationSegments: 0,
      summarizedMessages: 4,
      retainedConversationSegments: 1,
      retainedMessageCount: 2,
    };
    const summaryRecord = {
      version: 2 as const,
      id: 'summary-1',
      runId,
      turn: 2,
      strategyVersion: 'structured-summary-v2' as const,
      sourceDigest: 'source-digest',
      coveredMessageCount: 4,
      summary: 'summary',
      retainedTail: [],
      retainedTailDigest: 'tail-digest',
      tokensBefore: 12,
      tokensAfter: 7,
      summaryModel: 'test-model',
      createdAt: now,
      artifactRefs: [],
    };
    await repository.commitContext({
      sessionId: session.sessionId,
      runId,
      manifest: {
        version: 2,
        id: 'manifest-summary',
        runId,
        turn: 2,
        attempt: 2,
        createdAt: now,
        requestDigest: 'digest-summary',
        requestSerializedChars: 28,
        estimatedInputTokens: 7,
        tokenSource: 'estimated',
        maxOutputTokens: 1_000,
        reserveTokens: 500,
        breakdown,
        layers: [...summaryActivity.layers],
        activity: { ...summaryActivity, layers: [...summaryActivity.layers] },
        summaryRecordId: summaryRecord.id,
        artifactRefs: [],
        includedToolResultIds: [],
      },
      activity: { ...summaryActivity, layers: [...summaryActivity.layers] },
      summaryRecord,
    });

    const loaded = await repository.loadSession(session.sessionId);
    assert.equal(loaded?.ledger?.filter((record) => record.type === 'context_prepare_committed').length, 2);
    const visible = loaded?.ledger?.filter((record) => record.type === 'context_compaction_completed') ?? [];
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.type === 'context_compaction_completed' ? visible[0].presentation.operationRef : undefined, 'context-summary');
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

test('project knowledge is isolated by workspace identity', async () => {
  const repository = createSessionRepository({ projectId: `test-memory-scope-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const saved = await repository.writeProjectKnowledge('knowledge-a', 'workspace-a');
    await repository.writeProjectKnowledge('knowledge-b', 'workspace-b');
    assert.equal(saved.path, join(projectDir, 'workspace-data', 'workspace-a', 'DEXCODE.md'));
    assert.equal(await repository.readProjectKnowledge('workspace-a'), 'knowledge-a\n');
    assert.equal(await repository.readProjectKnowledge('workspace-b'), 'knowledge-b\n');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('legacy project-memory.md migrates to DEXCODE.md without changing content', async () => {
  const repository = createSessionRepository({ projectId: `test-project-knowledge-migration-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  const stateDir = join(projectDir, 'workspace-data', 'workspace-legacy');
  const legacyPath = join(stateDir, 'project-memory.md');
  const targetPath = join(stateDir, 'DEXCODE.md');
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(legacyPath, '# Existing project knowledge\n', 'utf8');

    const result = await repository.getProjectKnowledge('workspace-legacy');

    assert.equal(result.path, targetPath);
    assert.equal(result.content, '# Existing project knowledge\n');
    assert.equal(await readFile(targetPath, 'utf8'), '# Existing project knowledge\n');
    await assert.rejects(() => readFile(legacyPath, 'utf8'), /ENOENT/);
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

test('reopening an idle Session pauses residual Queue until explicit resume', async () => {
  const projectId = `test-idle-queue-recovery-${crypto.randomUUID()}`;
  const repository = createSessionRepository({ projectId });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.enqueueQueueItem({ sessionId: session.sessionId, content: 'resume later', delivery: 'next_run', operationId: 'enqueue-idle' });
    const reopened = createSessionRepository({ projectId });
    const first = await reopened.loadSession(session.sessionId);
    const second = await reopened.loadSession(session.sessionId);
    assert.equal((await reopened.getQueue(session.sessionId)).paused, true);
    assert.equal(first?.ledger?.filter((record) => record.type === 'queue_chain_paused').length, 1);
    assert.equal(second?.ledger?.filter((record) => record.type === 'queue_chain_paused').length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('JSONL Session starts with one immutable header and beginRun is one multi-record commit', async () => {
  const repository = createSessionRepository({ projectId: `test-jsonl-header-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const path = repository.journalPath(session.sessionId);
    const headerOnly = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(headerOnly, [{
      kind: 'header',
      version: 1,
      sessionId: session.sessionId,
      scope: { kind: 'general' },
      createdAt: session.createdAt,
    }]);

    await repository.beginRun({
      sessionId: session.sessionId,
      runId: 'run-atomic',
      clientRequestId: 'request-atomic',
      userMessage: { role: 'user', content: 'atomic start' },
      context: generalContext,
    });
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].kind, 'commit');
    assert.equal(lines[1].revision, 1);
    assert.deepEqual(lines[1].records.map((record: { type: string }) => record.type), [
      'session_meta_updated',
      'run_started',
      'message',
      'client_request_registered',
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('ordinary mutation appends one commit without rewriting the valid prefix', async () => {
  const repository = createSessionRepository({ projectId: `test-jsonl-append-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.appendMessages(session.sessionId, [{ role: 'user', content: 'first' }]);
    const path = repository.journalPath(session.sessionId);
    const prefix = await readFile(path, 'utf8');
    await repository.appendMessages(session.sessionId, [{ role: 'assistant', content: 'second' }]);
    const appended = await readFile(path, 'utf8');
    assert.equal(appended.startsWith(prefix), true);
    assert.equal(appended.trimEnd().split('\n').length, 3);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('a completed Session projection is deterministic after repository restart', async () => {
  const projectId = `test-jsonl-replay-${crypto.randomUUID()}`;
  const repository = createSessionRepository({ projectId });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.beginRun({ sessionId: session.sessionId, runId: 'run-replay', userMessage: { role: 'user', content: 'replay' }, context: generalContext });
    await repository.appendRunMessage({ sessionId: session.sessionId, runId: 'run-replay', message: { role: 'assistant', content: 'done' }, messageId: 'answer-1', turn: 1 });
    await repository.finishRun({ sessionId: session.sessionId, ...terminal('run-replay') });
    const before = await repository.loadSession(session.sessionId);
    const reopened = createSessionRepository({ projectId });
    const after = await reopened.loadSession(session.sessionId);
    assert.deepEqual(after, before);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('a torn final line is discarded and the repaired journal remains appendable', async () => {
  const projectId = `test-jsonl-torn-${crypto.randomUUID()}`;
  const repository = createSessionRepository({ projectId });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.appendMessages(session.sessionId, [{ role: 'user', content: 'kept' }]);
    const path = repository.journalPath(session.sessionId);
    await appendFile(path, '{"kind":"commit","version":1');
    const reopened = createSessionRepository({ projectId });
    const recovered = await reopened.loadSession(session.sessionId);
    assert.equal(recovered?.revision, 1);
    assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
    const next = await reopened.appendMessages(session.sessionId, [{ role: 'assistant', content: 'after repair' }]);
    assert.equal(next.revision, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('malformed middle lines and revision gaps fail closed with file and line evidence', async () => {
  for (const mode of ['syntax', 'revision'] as const) {
    const projectId = `test-jsonl-corrupt-${mode}-${crypto.randomUUID()}`;
    const repository = createSessionRepository({ projectId });
    const projectDir = dirname(repository.sessionsDir);
    try {
      const session = await repository.createSession();
      await repository.appendMessages(session.sessionId, [{ role: 'user', content: 'one' }]);
      await repository.appendMessages(session.sessionId, [{ role: 'assistant', content: 'two' }]);
      const path = repository.journalPath(session.sessionId);
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
      if (mode === 'syntax') lines[1] = '{broken';
      else {
        const commit = JSON.parse(lines[2]!);
        commit.revision = 3;
        lines[2] = JSON.stringify(commit);
      }
      await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
      const reopened = createSessionRepository({ projectId });
      await assert.rejects(
        () => reopened.loadSession(session.sessionId),
        mode === 'syntax' ? /\.jsonl:2: commit is not valid JSON/ : /\.jsonl:3: revision expected 2, received 3/,
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }
});

test('concurrent mutations for one Session serialize into strict revisions', async () => {
  const repository = createSessionRepository({ projectId: `test-jsonl-concurrency-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await Promise.all(Array.from({ length: 24 }, (_, index) => (
      repository.appendMessages(session.sessionId, [{ role: 'user', content: `message-${index}` }])
    )));
    const loaded = await repository.loadSession(session.sessionId);
    assert.equal(loaded?.messages.length, 24);
    assert.equal(loaded?.revision, 24);
    const commits = (await readFile(repository.journalPath(session.sessionId), 'utf8')).trimEnd().split('\n').slice(1).map((line) => JSON.parse(line));
    assert.deepEqual(commits.map((commit) => commit.revision), Array.from({ length: 24 }, (_, index) => index + 1));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Session listing uses the lightweight sidecar while direct load still validates the journal', async () => {
  const projectId = `test-jsonl-index-${crypto.randomUUID()}`;
  const repository = createSessionRepository({ projectId });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.appendMessages(session.sessionId, [{ role: 'user', content: 'indexed' }]);
    const path = repository.journalPath(session.sessionId);
    const content = await readFile(path, 'utf8');
    await writeFile(path, content.replace('"kind":"commit"', '"kind":"xxxxxx"'), 'utf8');
    const reopened = createSessionRepository({ projectId });
    assert.deepEqual((await reopened.listSessions()).map((item) => item.sessionId), [session.sessionId]);
    await assert.rejects(() => reopened.loadSession(session.sessionId), /\.jsonl:2: line is not a commit/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('canonical export returns the exact JSONL journal', async () => {
  const repository = createSessionRepository({ projectId: `test-jsonl-export-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.appendMessages(session.sessionId, [{ role: 'user', content: 'export me' }]);
    assert.equal(await repository.exportSession(session.sessionId), await readFile(repository.journalPath(session.sessionId), 'utf8'));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('a 10,000-commit journal replays and accepts a true append afterward', async () => {
  const repository = createSessionRepository({ projectId: `test-jsonl-long-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  const sessionId = `session-${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  try {
    const path = repository.journalPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    const lines = [JSON.stringify({ kind: 'header', version: 1, sessionId, scope: { kind: 'general' }, createdAt })];
    for (let revision = 1; revision <= 10_000; revision += 1) {
      lines.push(JSON.stringify({
        kind: 'commit',
        version: 1,
        commitId: `commit-${revision}`,
        sessionId,
        revision,
        at: createdAt,
        records: [{ type: 'session_message_committed', message: { role: 'user', content: `m${revision}` } }],
      }));
    }
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
    const replayed = await repository.loadSession(sessionId);
    assert.equal(replayed?.revision, 10_000);
    assert.equal(replayed?.messages.length, 10_000);
    const prefix = await readFile(path, 'utf8');
    const appended = await repository.appendMessages(sessionId, [{ role: 'assistant', content: 'tail' }]);
    assert.equal(appended.revision, 10_001);
    assert.equal((await readFile(path, 'utf8')).startsWith(prefix), true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
