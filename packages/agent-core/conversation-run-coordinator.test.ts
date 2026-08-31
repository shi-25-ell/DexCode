import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import type { AgentEvent, RunReport, TaskSummary } from '../shared/types.ts';
import { createSessionRepository } from '../session-store/index.ts';
import { createConversationRunCoordinator } from './conversation-run-coordinator.ts';

const context = { scope: { kind: 'general' as const } };

function terminal(runId: string, prompt: string, status: TaskSummary['status'] = 'completed') {
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const summary: TaskSummary = { taskId: runId, prompt, startedAt, completedAt, status, summary: prompt, toolsUsed: [], filesModified: [] };
  const report: RunReport = {
    version: 1,
    runId,
    context,
    status,
    terminationReason: status === 'completed' ? 'natural_completion' : 'user_abort',
    startedAt,
    completedAt,
    modelTurnCount: 1,
    modelAttemptCount: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, unknown: 0 },
    toolsUsed: [],
    filesModified: [],
  };
  return { summary, report };
}

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('Coordinator drains next-run Queue items into distinct durable Runs', async () => {
  const repository = createSessionRepository({ projectId: `test-coordinator-drain-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.enqueueQueueItem({ sessionId: session.sessionId, content: 'second run', delivery: 'next_run', operationId: 'enqueue-next' });
    const agent = {
      async runTask(sessionId: string, prompt: string, _selectedFile: string | null, _onEvent: (event: AgentEvent) => void, _hooks: unknown, options: any) {
        if (!options.prestarted) await repository.beginRun({ sessionId, runId: options.runId, userMessage: { role: 'user', content: prompt }, context });
        const decision = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 1, wouldNaturallyComplete: true });
        assert.equal(decision.action, 'finish');
        const value = terminal(options.runId, prompt);
        await repository.finishRun({ sessionId, report: value.report, summary: value.summary });
        return value.summary;
      },
    };
    const events: AgentEvent[] = [];
    const coordinator = createConversationRunCoordinator({ repository, resolveEnvironment: async () => ({ agent, context }), createHooks: () => ({}) });
    const result = await coordinator.start({ sessionId: session.sessionId, runId: 'run-first', prompt: 'first run', prestarted: false }, (event) => events.push(event));
    const loaded = await repository.loadSession(session.sessionId);
    assert.equal(result.summaries.length, 2);
    assert.equal(loaded?.runReports?.length, 2);
    assert.deepEqual(loaded?.messages.filter((message) => message.role === 'user').map((message) => message.content), ['first run', 'second run']);
    assert.equal(events.filter((event) => event.type === 'run_started').length, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Coordinator promotes and consumes Steer in the active Run without starting another Run', async () => {
  const repository = createSessionRepository({ projectId: `test-coordinator-steer-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const entered = deferred();
    const continueRun = deferred();
    const agent = {
      async runTask(sessionId: string, prompt: string, _selectedFile: string | null, _onEvent: (event: AgentEvent) => void, _hooks: unknown, options: any) {
        await repository.beginRun({ sessionId, runId: options.runId, userMessage: { role: 'user', content: prompt }, context });
        entered.release();
        await continueRun.promise;
        const first = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 2, wouldNaturallyComplete: true });
        assert.equal(first.action, 'continue');
        const second = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 1, wouldNaturallyComplete: true });
        assert.equal(second.action, 'finish');
        const value = terminal(options.runId, prompt);
        await repository.finishRun({ sessionId, report: value.report, summary: value.summary });
        return value.summary;
      },
    };
    const coordinator = createConversationRunCoordinator({ repository, resolveEnvironment: async () => ({ agent, context }), createHooks: () => ({}) });
    const running = coordinator.start({ sessionId: session.sessionId, runId: 'run-steer', prompt: 'initial', prestarted: false }, () => {});
    await entered.promise;
    const queued = await coordinator.submitDuringRun({ sessionId: session.sessionId, content: 'change direction', delivery: 'next_run', operationId: 'enqueue-steer' });
    assert.equal(queued.outcome, 'queued');
    if (!('item' in queued)) throw new Error('Queue item missing');
    const promoted = await coordinator.mutateQueue({ type: 'promote_to_steer', sessionId: session.sessionId, itemId: queued.item.itemId, expectedRunId: 'run-steer', operationId: 'promote-steer' });
    assert.equal('outcome' in promoted ? promoted.outcome : undefined, 'steered');
    continueRun.release();
    const result = await running;
    const loaded = await repository.loadSession(session.sessionId);
    assert.equal(result.summaries.length, 1);
    assert.equal(loaded?.runReports?.length, 1);
    assert.deepEqual(loaded?.messages.filter((message) => message.role === 'user').map((message) => message.content), ['initial', 'change direction']);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Coordinator accepts Steer while approval is pending and consumes it after approval settles', async () => {
  const repository = createSessionRepository({ projectId: `test-coordinator-approval-steer-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const approvalEntered = deferred();
    const resolveApproval = deferred();
    const agent = {
      async runTask(sessionId: string, prompt: string, _selectedFile: string | null, _onEvent: (event: AgentEvent) => void, hooks: any, options: any) {
        await repository.beginRun({ sessionId, runId: options.runId, userMessage: { role: 'user', content: prompt }, context });
        const request = {
          version: 1 as const,
          toolName: 'write_file',
          effect: 'write' as const,
          title: '修改文件',
          reason: '测试批准期间的 Steer',
          fingerprint: 'approval-fingerprint',
          options: ['allow_once', 'deny'] as const,
        };
        const approval = await hooks.onApproval(request);
        assert.equal(approval.decision, 'allow_once');
        const steered = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 2, wouldNaturallyComplete: false });
        assert.equal(steered.action, 'continue');
        assert.equal(steered.directive, 'change direction after approval');
        const promoted = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 1, wouldNaturallyComplete: false });
        assert.equal(promoted.action, 'continue');
        assert.equal(promoted.directive, 'promote after approval');
        const finish = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 1, wouldNaturallyComplete: true });
        assert.equal(finish.action, 'finish');
        const value = terminal(options.runId, prompt);
        await repository.finishRun({ sessionId, report: value.report, summary: value.summary });
        return value.summary;
      },
    };
    const coordinator = createConversationRunCoordinator({
      repository,
      resolveEnvironment: async () => ({ agent, context }),
      createHooks: (_sessionId, runId, sink) => ({
        onApproval: async (request) => {
          sink({ ...request, type: 'approval_request', taskId: runId, approvalId: 'approval-1' });
          approvalEntered.release();
          await resolveApproval.promise;
          return { decision: 'allow_once', fingerprint: request.fingerprint };
        },
      }),
    });

    const running = coordinator.start({ sessionId: session.sessionId, runId: 'run-approval-steer', prompt: 'initial', prestarted: false }, () => {});
    await approvalEntered.promise;
    assert.equal((await coordinator.snapshot(session.sessionId)).activeRun?.phase, 'waiting_confirm');
    const outcome = await coordinator.submitDuringRun({
      sessionId: session.sessionId,
      content: 'change direction after approval',
      delivery: 'steer',
      expectedRunId: 'run-approval-steer',
      operationId: 'steer-during-approval',
    });
    assert.equal(outcome.outcome, 'steered');
    if (outcome.outcome === 'steered') {
      assert.equal(outcome.targetRunId, 'run-approval-steer');
      assert.equal(outcome.item.delivery, 'steer');
    }
    const queued = await coordinator.submitDuringRun({
      sessionId: session.sessionId,
      content: 'promote after approval',
      delivery: 'next_run',
      operationId: 'queue-during-approval',
    });
    if (!('item' in queued)) throw new Error('Queue item missing');
    const promoted = await coordinator.mutateQueue({
      type: 'promote_to_steer',
      sessionId: session.sessionId,
      itemId: queued.item.itemId,
      expectedRunId: 'run-approval-steer',
      operationId: 'promote-during-approval',
    });
    assert.equal('outcome' in promoted ? promoted.outcome : undefined, 'steered');

    resolveApproval.release();
    const result = await running;
    const loaded = await repository.loadSession(session.sessionId);
    assert.equal(result.summaries.length, 1);
    assert.equal(loaded?.runReports?.length, 1);
    assert.deepEqual(loaded?.messages.filter((message) => message.role === 'user').map((message) => message.content), ['initial', 'change direction after approval', 'promote after approval']);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Coordinator Stop aborts only the active Run and preserves a paused Queue', async () => {
  const repository = createSessionRepository({ projectId: `test-coordinator-stop-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const entered = deferred();
    const agent = {
      async runTask(sessionId: string, prompt: string, _selectedFile: string | null, _onEvent: (event: AgentEvent) => void, _hooks: unknown, options: any) {
        await repository.beginRun({ sessionId, runId: options.runId, userMessage: { role: 'user', content: prompt }, context });
        entered.release();
        await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
        const value = terminal(options.runId, prompt, 'aborted');
        await repository.finishRun({ sessionId, report: value.report, summary: value.summary });
        return value.summary;
      },
    };
    const coordinator = createConversationRunCoordinator({ repository, resolveEnvironment: async () => ({ agent, context }), createHooks: () => ({}) });
    const running = coordinator.start({ sessionId: session.sessionId, runId: 'run-stop', prompt: 'initial', prestarted: false }, () => {});
    await entered.promise;
    await coordinator.submitDuringRun({ sessionId: session.sessionId, content: 'keep me', delivery: 'next_run', operationId: 'enqueue-keep' });
    assert.equal((await coordinator.stop({ runId: 'run-stop' })).stopped, true);
    await running;
    const queue = await repository.getQueue(session.sessionId);
    assert.equal(queue.paused, true);
    assert.deepEqual(queue.pending.map((item) => item.content), ['keep me']);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('promote racing with natural closing remains queued and drains without loss', async () => {
  const repository = createSessionRepository({ projectId: `test-coordinator-closing-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const firstStarted = deferred();
    const enterBoundary = deferred();
    const closing = deferred();
    const finishFirst = deferred();
    let calls = 0;
    const agent = {
      async runTask(sessionId: string, prompt: string, _selectedFile: string | null, _onEvent: (event: AgentEvent) => void, _hooks: unknown, options: any) {
        calls += 1;
        if (!options.prestarted) await repository.beginRun({ sessionId, runId: options.runId, userMessage: { role: 'user', content: prompt }, context });
        if (calls === 1) {
          firstStarted.release();
          await enterBoundary.promise;
        }
        const decision = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 1, wouldNaturallyComplete: true });
        assert.equal(decision.action, 'finish');
        if (calls === 1) {
          closing.release();
          await finishFirst.promise;
        }
        const value = terminal(options.runId, prompt);
        await repository.finishRun({ sessionId, report: value.report, summary: value.summary });
        return value.summary;
      },
    };
    const coordinator = createConversationRunCoordinator({ repository, resolveEnvironment: async () => ({ agent, context }), createHooks: () => ({}) });
    const running = coordinator.start({ sessionId: session.sessionId, runId: 'run-closing', prompt: 'initial', prestarted: false }, () => {});
    await firstStarted.promise;
    const queued = await coordinator.submitDuringRun({ sessionId: session.sessionId, content: 'must survive', delivery: 'next_run', operationId: 'enqueue-race' });
    if (!('item' in queued)) throw new Error('Queue item missing');
    enterBoundary.release();
    await closing.promise;
    const promoted = await coordinator.mutateQueue({ type: 'promote_to_steer', sessionId: session.sessionId, itemId: queued.item.itemId, expectedRunId: 'run-closing', operationId: 'promote-race' });
    assert.equal('outcome' in promoted ? promoted.outcome : undefined, 'remained_queued');
    if ('outcome' in promoted && promoted.outcome === 'remained_queued') assert.equal(promoted.reason, 'run_closing');
    finishFirst.release();
    const result = await running;
    const loaded = await repository.loadSession(session.sessionId);
    assert.equal(result.summaries.length, 2);
    assert.deepEqual(loaded?.messages.filter((message) => message.role === 'user').map((message) => message.content), ['initial', 'must survive']);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('failed Queue resume releases the session chain for a later retry', async () => {
  const repository = createSessionRepository({ projectId: `test-coordinator-resume-retry-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    await repository.enqueueQueueItem({ sessionId: session.sessionId, content: 'retry me', delivery: 'next_run', operationId: 'enqueue-retry' });
    let failResolution = true;
    const agent = {
      async runTask(sessionId: string, prompt: string, _selectedFile: string | null, _onEvent: (event: AgentEvent) => void, _hooks: unknown, options: any) {
        const decision = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 1, wouldNaturallyComplete: true });
        assert.equal(decision.action, 'finish');
        const value = terminal(options.runId, prompt);
        await repository.finishRun({ sessionId, report: value.report, summary: value.summary });
        return value.summary;
      },
    };
    const coordinator = createConversationRunCoordinator({
      repository,
      resolveEnvironment: async () => {
        if (failResolution) throw new Error('temporary environment failure');
        return { agent, context };
      },
      createHooks: () => ({}),
    });

    await assert.rejects(coordinator.resume(session.sessionId, () => {}), /temporary environment failure/);
    failResolution = false;
    const retried = await coordinator.resume(session.sessionId, () => {});

    assert.equal(retried.summaries.length, 1);
    assert.equal((await repository.getQueue(session.sessionId)).pending.length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Coordinator gives Steer priority, then injects one grouped Agent Inbox notification at a safe boundary', async () => {
  const repository = createSessionRepository({ projectId: `test-coordinator-agent-inbox-${crypto.randomUUID()}` });
  const projectDir = dirname(repository.sessionsDir);
  try {
    const session = await repository.createSession();
    const entered = deferred();
    const proceed = deferred();
    const notifications = ['agent-run-1', 'agent-run-2'].map((agentRunId, index) => ({
      notificationId: `notification-${agentRunId}`,
      agentId: `agent-${index + 1}`,
      agentRunId,
      delegationGroupId: 'delegation-main-1',
      createdAt: new Date(Date.now() + index).toISOString(),
      summary: `result-${index + 1}`,
      result: { status: 'completed', terminationReason: 'natural_completion', finalContent: `result-${index + 1}` },
    }));
    const consumed: string[] = [];
    const agentInbox = {
      pending: async () => notifications.filter((item) => !consumed.includes(item.notificationId)),
      consume: async (_sessionId: string, ids: string[]) => { consumed.push(...ids); },
    };
    const agent = {
      async runTask(sessionId: string, prompt: string, _selectedFile: string | null, _onEvent: (event: AgentEvent) => void, _hooks: unknown, options: any) {
        await repository.beginRun({ sessionId, runId: options.runId, userMessage: { role: 'user', content: prompt }, context });
        entered.release();
        await proceed.promise;
        const steer = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 3, wouldNaturallyComplete: true });
        assert.equal(steer.action, 'continue');
        assert.equal(steer.directive, 'urgent user steer');
        const inbox = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 2, wouldNaturallyComplete: true });
        assert.equal(inbox.action, 'continue');
        assert.equal(inbox.refreshContext, false);
        assert.match(inbox.directive, /result-1/);
        assert.match(inbox.directive, /result-2/);
        const finish = await options.commandSource.atSafeBoundary({ sessionId, runId: options.runId, remainingModelTurns: 1, wouldNaturallyComplete: true });
        assert.equal(finish.action, 'finish');
        const value = terminal(options.runId, prompt);
        await repository.finishRun({ sessionId, report: value.report, summary: value.summary });
        return value.summary;
      },
    };
    const coordinator = createConversationRunCoordinator({ repository, agentInbox, resolveEnvironment: async () => ({ agent, context }), createHooks: () => ({}) });
    const running = coordinator.start({ sessionId: session.sessionId, runId: 'run-agent-inbox', prompt: 'initial', prestarted: false }, () => {});
    await entered.promise;
    await coordinator.submitDuringRun({ sessionId: session.sessionId, content: 'urgent user steer', delivery: 'steer', expectedRunId: 'run-agent-inbox', operationId: 'steer-before-agent' });
    proceed.release();
    await running;
    assert.deepEqual(consumed.sort(), notifications.map((item) => item.notificationId).sort());
    const loaded = await repository.loadSession(session.sessionId);
    assert.equal(loaded?.runReports?.length, 1);
    assert.equal(loaded?.ledger?.filter((record) => record.type === 'message' && record.origin?.startsWith('agent_notification:')).length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
