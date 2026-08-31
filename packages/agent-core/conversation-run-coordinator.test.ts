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
