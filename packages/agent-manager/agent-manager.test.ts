import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { BUILTIN_AGENT_DEFINITIONS, createAgentDefinitionRegistry, parseAgentDefinitionMarkdown } from './agent-definitions.ts';
import { createAgentStore } from './agent-store.ts';
import type { AgentRecord, AgentRunRecord } from './contracts.ts';
import { createAgentManager, multiAgentEnabled } from './agent-manager.ts';
import type { AgentRunResult } from '../agent-core/agent-runtime.ts';

function records(sessionId: string) {
  const now = new Date().toISOString();
  const definition = structuredClone(BUILTIN_AGENT_DEFINITIONS[0]!);
  const agent: AgentRecord = {
    agentId: 'agent-a', sessionId, rootAgentId: 'agent-root', parentAgentId: null, createdByRunId: 'main-1',
    name: 'researcher', task: 'inspect', contextMode: 'fresh', isolation: 'shared', definitionName: definition.name,
    definitionDigest: 'sha256-test', definitionSnapshot: definition, contextSeed: [], status: 'running', currentRunId: 'agent-run-a',
    lastRunId: 'agent-run-a', createdAt: now, updatedAt: now,
  };
  const run: AgentRunRecord = { agentRunId: 'agent-run-a', agentId: agent.agentId, invokedByRunId: 'main-1', trigger: 'spawn', status: 'running', input: 'inspect', startedAt: now };
  return { agent, run };
}

test('Agent Store is lazy, repairs a torn tail and recovers once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-store-'));
  const sessionId = 'session-abcd';
  try {
    const store = createAgentStore({ sessionsDir: root });
    assert.equal(await store.load(sessionId), null);
    const { agent, run } = records(sessionId);
    await store.createAgentRun(sessionId, agent, run, 'main-1:tool-1');
    const path = store.pathFor(sessionId);
    await writeFile(path, `${await readFile(path, 'utf8')}{"torn":`, 'utf8');
    const reopened = createAgentStore({ sessionsDir: root });
    const recovered = await reopened.load(sessionId);
    assert.equal(recovered?.revision, 2);
    assert.equal(recovered?.runs[0]?.status, 'interrupted');
    assert.equal(recovered?.inbox[0]?.status, 'pending');
    assert.equal(recovered?.inbox[0]?.agentRunId, 'agent-run-a');
    await reopened.consumeNotifications(sessionId, [recovered!.inbox[0]!.notificationId], 'main-recovery-run');
    const afterConsumption = await createAgentStore({ sessionsDir: root }).load(sessionId, false);
    assert.equal(afterConsumption?.inbox[0]?.status, 'consumed');
    assert.equal(afterConsumption?.inbox[0]?.consumedByRunId, 'main-recovery-run');
    assert.equal((await reopened.load(sessionId))?.revision, 3);
    assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Agent Store serializes concurrent appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-store-order-'));
  const sessionId = 'session-efgh';
  try {
    const store = createAgentStore({ sessionsDir: root });
    const { agent, run } = records(sessionId);
    await store.createAgentRun(sessionId, agent, run, 'main-1:tool-1');
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.append(sessionId, [{ type: 'agent_message_committed', agentId: agent.agentId, agentRunId: run.agentRunId, message: { role: 'user', content: String(index) } }])));
    const snapshot = await store.load(sessionId, false);
    assert.equal(snapshot?.revision, 13);
    assert.equal(snapshot?.conversations[0]?.messages.length, 13);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Definition parser rejects unknown fields and workspace definitions override user definitions', async () => {
  assert.throws(() => parseAgentDefinitionMarkdown('---\nname: scout\ndescription: test\nunknown: true\n---\nPrompt'), /Unknown/);
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-def-'));
  const user = join(root, 'user');
  const workspace = join(root, 'workspace');
  await mkdir(user); await mkdir(workspace);
  const file = (description: string) => `---\nname: scout\ndescription: ${description}\nallowed-tools: [read_file]\n---\nInspect source.`;
  try {
    await writeFile(join(user, 'scout.md'), file('user'), 'utf8');
    await writeFile(join(workspace, 'scout.md'), file('workspace'), 'utf8');
    const registry = createAgentDefinitionRegistry({ userRoot: user, workspaceRoot: workspace });
    await registry.reload();
    assert.equal(registry.resolve('scout')?.definition.description, 'workspace');
    assert.deepEqual(registry.diagnostics(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('child Agent definitions have bounded capabilities and long-task budgets', () => {
  const generalPurpose = BUILTIN_AGENT_DEFINITIONS.find((definition) => definition.name === 'general-purpose');
  assert.deepEqual(generalPurpose?.toolPolicy.allow, ['read_file', 'find', 'ls', 'list_workspace', 'grep', 'write_file', 'patch_file']);
  assert.equal(generalPurpose?.toolPolicy.allow?.includes('run_command'), false);
  assert.equal(BUILTIN_AGENT_DEFINITIONS.some((definition) => definition.name === 'assistant'), true);
  for (const definition of BUILTIN_AGENT_DEFINITIONS.filter((item) => item.name !== 'general-purpose')) {
    assert.equal(definition.toolPolicy.allow?.includes('write_file'), false);
    assert.equal(definition.toolPolicy.allow?.includes('patch_file'), false);
  }
  assert.equal(BUILTIN_AGENT_DEFINITIONS[0]?.budget.maxModelTurns, 64);
  assert.equal(BUILTIN_AGENT_DEFINITIONS[0]?.budget.modelRequestTimeoutMs, 300_000);
  assert.equal(BUILTIN_AGENT_DEFINITIONS[0]?.budget.maxTotalTokens, 1_500_000);
  assert.equal(BUILTIN_AGENT_DEFINITIONS[1]?.budget.maxModelTurns, 64);
  const parsed = parseAgentDefinitionMarkdown('---\nname: scout\ndescription: test\n---\nInspect source.');
  assert.equal(parsed.budget.maxModelTurns, 64);
});

test('Multi-Agent is available by default and can be explicitly disabled', () => {
  assert.equal(multiAgentEnabled({}), true);
  assert.equal(multiAgentEnabled({ MULTI_AGENT_ENABLED: '' }), true);
  assert.equal(multiAgentEnabled({ MULTI_AGENT_ENABLED: 'false' }), false);
  assert.equal(multiAgentEnabled({ MULTI_AGENT_ENABLED: 'off' }), false);
  assert.equal(multiAgentEnabled({ MULTI_AGENT_ENABLED: 'true' }), true);
});

test('AgentManager runs parallel children, waits, follows up and stops without deleting identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-manager-'));
  const sessionId = 'session-manager';
  const store = createAgentStore({ sessionsDir: root });
  const definitions = createAgentDefinitionRegistry();
  const completedInputs: string[] = [];
  const runChild = async ({ run, persistenceHooks, signal }: Parameters<Parameters<typeof createAgentManager>[0]['runChild']>[0]): Promise<AgentRunResult> => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, run.input === 'slow' ? 500 : 15);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (!signal.aborted) {
      completedInputs.push(run.input);
      await persistenceHooks.assistantCommitted({ role: 'assistant', content: `done:${run.input}` }, { messageId: crypto.randomUUID(), turn: 1 });
    }
    const now = new Date().toISOString();
    return {
      runId: run.agentRunId, parentRunId: run.invokedByRunId, profile: 'child', origin: 'orchestrated',
      status: signal.aborted ? 'aborted' : 'completed', terminationReason: signal.aborted ? 'user_abort' : 'natural_completion',
      finalContent: signal.aborted ? '' : `done:${run.input}`, messages: [], modelTurnCount: 1, modelAttemptCount: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, unknown: 0 }, toolsUsed: [], filesModified: [], fileChanges: [], skillsUsed: [],
      contextSummaryUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, contextRefreshWarnings: [], runtimeWarnings: [],
      startedAt: now, completedAt: now, durationMs: 1,
    };
  };
  const manager = createAgentManager({ enabled: true, store, definitions, runChild });
  const caller = (toolCallId: string) => ({ sessionId, callerRunId: 'main-run', callerTurn: 1, toolCallId, delegationGroupId: 'group-1', forkSnapshot: [] });
  try {
    assert.equal(definitions.resolve('assistant')?.definition.name, 'assistant');
    assert.deepEqual(manager.definitions().map(({ name }) => name), ['general-purpose', 'researcher', 'reviewer']);
    const missing = await manager.spawn({ task: 'hello', agent: 'greeter' }, caller('spawn-missing')) as { code: string; message: string };
    assert.equal(missing.code, 'definition_not_found');
    assert.match(missing.message, /Available agents: general-purpose, researcher, reviewer/);
    assert.doesNotMatch(missing.message, /assistant/);
    const first = await manager.spawn({ task: 'one' }, caller('spawn-1')) as { agent_id: string; message: string; asynchronous: boolean; background?: boolean };
    assert.equal(first.asynchronous, true);
    assert.equal(first.background, undefined);
    assert.match(first.message, /foreground wait_agent\(block=true\).*background completion/i);
    const firstDetail = await manager.detail(sessionId, first.agent_id);
    assert.equal(firstDetail?.agent.definitionName, 'general-purpose');
    assert.deepEqual(firstDetail?.tools, []);
    const firstRun = (await manager.detail(sessionId, first.agent_id))?.runs[0];
    assert.equal(firstRun?.invokedByTurn, 1);
    assert.equal(firstRun?.invokedByToolCallId, 'spawn-1');
    assert.equal(firstRun?.delegationGroupId, 'group-1');
    const second = await manager.spawn({ task: 'two', agent: 'reviewer' }, caller('spawn-2')) as { agent_id: string };
    const immediate = await manager.wait({ agentIds: [first.agent_id, second.agent_id], mode: 'all' }, caller('wait-now')) as { completed: unknown[]; block: boolean };
    assert.equal(immediate.block, false);
    const waited = await manager.wait({ agentIds: [first.agent_id, second.agent_id], mode: 'all', block: true, timeoutMs: 1_000 }, caller('wait-1')) as { completed: unknown[]; timed_out: boolean };
    assert.equal(waited.timed_out, false);
    assert.equal(immediate.completed.length + waited.completed.length, 2);
    assert.deepEqual(await store.pendingNotifications(sessionId), []);
    const deliveredInbox = (await store.load(sessionId, false))!.inbox;
    assert.equal(deliveredInbox.length, 2);
    assert.ok(deliveredInbox.every((item) => item.delegationGroupId === 'group-1' && item.status === 'consumed' && item.consumedByRunId === 'main-run'));
    const followup = await manager.followup({ agentId: first.agent_id, task: 'three' }, caller('followup-1')) as { agent_run_id: string; asynchronous: boolean; background?: boolean };
    assert.match(followup.agent_run_id, /^agent-run-/);
    assert.equal(followup.asynchronous, true);
    assert.equal(followup.background, undefined);
    const followupRun = (await manager.detail(sessionId, first.agent_id))?.runs.at(-1);
    assert.equal(followupRun?.trigger, 'followup');
    assert.equal(followupRun?.invokedByTurn, 1);
    assert.equal(followupRun?.invokedByToolCallId, 'followup-1');
    assert.equal(followupRun?.delegationGroupId, 'group-1');
    await manager.wait({ agentIds: [first.agent_id], block: true, timeoutMs: 1_000 }, caller('wait-2'));
    const afterFollowupDelivery = (await store.load(sessionId, false))!;
    const firstAgentNotifications = afterFollowupDelivery.inbox.filter((item) => item.agentId === first.agent_id);
    assert.equal(firstAgentNotifications.length, 2);
    assert.deepEqual(firstAgentNotifications.map((item) => item.agentRunId), [firstRun!.agentRunId, followup.agent_run_id]);
    assert.ok(firstAgentNotifications.every((item) => item.status === 'consumed' && item.consumedByRunId === 'main-run'));
    const slow = await manager.spawn({ task: 'slow', agent: 'researcher' }, caller('spawn-3')) as { agent_id: string };
    const waitAbort = new AbortController();
    const cancelledWait = manager.wait(
      { agentIds: [slow.agent_id], block: true, timeoutMs: 1_000 },
      { ...caller('wait-cancelled'), signal: waitAbort.signal },
    ) as Promise<{ cancelled: boolean }>;
    waitAbort.abort('stop main only');
    assert.equal((await cancelledWait).cancelled, true);
    assert.equal((await manager.detail(sessionId, slow.agent_id))?.agent.status, 'running');
    assert.equal((await manager.stop({ agentId: slow.agent_id }, caller('stop-1')) as { status: string }).status, 'stopped');
    await manager.wait({ agentIds: [slow.agent_id], block: true, timeoutMs: 1_000 }, caller('wait-3'));
    assert.match((await manager.followup({ agentId: slow.agent_id, task: 'after-stop' }, caller('followup-2')) as { agent_run_id: string }).agent_run_id, /^agent-run-/);
    await manager.wait({ agentIds: [slow.agent_id], block: true, timeoutMs: 1_000 }, caller('wait-4'));
    assert.deepEqual(completedInputs.sort(), ['after-stop', 'one', 'three', 'two'].sort());
    assert.equal((await manager.detail(sessionId, first.agent_id))?.runs.length, 2);
    const background = await manager.spawn(
      { task: 'background' },
      { ...caller('spawn-background'), callerRunId: 'main-background' },
    ) as { agent_id: string };
    let pendingBackground = await store.pendingNotifications(sessionId);
    const notificationDeadline = Date.now() + 1_000;
    while (pendingBackground.length === 0 && Date.now() < notificationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      pendingBackground = await store.pendingNotifications(sessionId);
    }
    assert.equal(pendingBackground.length, 1);
    assert.equal(pendingBackground[0]?.agentId, background.agent_id);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('AgentManager delivers each terminal once and opens the no-progress circuit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-circuit-'));
  const sessionId = 'session-circuit';
  const store = createAgentStore({ sessionsDir: root });
  const definitions = createAgentDefinitionRegistry();
  const runChild = async ({ run }: Parameters<Parameters<typeof createAgentManager>[0]['runChild']>[0]): Promise<AgentRunResult> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const now = new Date().toISOString();
    return {
      runId: run.agentRunId, parentRunId: run.invokedByRunId, profile: 'child', origin: 'orchestrated', status: 'completed', terminationReason: 'natural_completion',
      finalContent: 'done', messages: [], modelTurnCount: 1, modelAttemptCount: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, unknown: 0 },
      toolsUsed: [], filesModified: [], fileChanges: [], skillsUsed: [], contextSummaryUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextRefreshWarnings: [], runtimeWarnings: [], startedAt: now, completedAt: now, durationMs: 1,
    };
  };
  const manager = createAgentManager({ enabled: true, store, definitions, runChild });
  const caller = (toolCallId: string) => ({ sessionId, callerRunId: 'main-circuit', callerTurn: 1, toolCallId, delegationGroupId: 'group-circuit', forkSnapshot: [] });
  try {
    const spawned = await manager.spawn({ task: 'finish' }, caller('spawn')) as { agent_id: string };
    const first = await manager.wait({ agentIds: [spawned.agent_id], block: true, timeoutMs: 1_000 }, caller('wait-1')) as { completed: unknown[] };
    assert.equal(first.completed.length, 1);
    for (const id of ['wait-2', 'wait-3', 'wait-4']) {
      const duplicate = await manager.wait({ agentIds: [spawned.agent_id] }, caller(id)) as { status: string; code: string; completed: unknown[] };
      assert.equal(duplicate.status, 'no_change');
      assert.equal(duplicate.code, 'already_observed');
      assert.deepEqual(duplicate.completed, []);
    }
    const circuit = await manager.wait({ agentIds: [spawned.agent_id] }, caller('wait-5')) as { code: string; orchestration_circuit_open: boolean };
    assert.equal(circuit.code, 'orchestration_stalled');
    assert.equal(circuit.orchestration_circuit_open, true);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('session stop is durable, consumes terminal notifications and requires an explicit resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-stop-session-'));
  const sessionId = 'session-stop-all';
  const store = createAgentStore({ sessionsDir: root });
  const definitions = createAgentDefinitionRegistry();
  const runChild = async ({ run, signal }: Parameters<Parameters<typeof createAgentManager>[0]['runChild']>[0]): Promise<AgentRunResult> => {
    if (run.input === 'blocked') await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    const now = new Date().toISOString();
    return {
      runId: run.agentRunId, parentRunId: run.invokedByRunId, profile: 'child', origin: 'orchestrated',
      status: signal.aborted ? 'aborted' : 'completed', terminationReason: signal.aborted ? 'user_abort' : 'natural_completion', finalContent: '',
      messages: [], modelTurnCount: 1, modelAttemptCount: 1, usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1, unknown: 0 }, toolsUsed: [], filesModified: [], fileChanges: [], skillsUsed: [],
      contextSummaryUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, contextRefreshWarnings: [], runtimeWarnings: [], startedAt: now, completedAt: now, durationMs: 1,
    };
  };
  const manager = createAgentManager({ enabled: true, store, definitions, runChild });
  const caller = (toolCallId: string, callerRunId = 'main-stop') => ({ sessionId, callerRunId, callerTurn: 1, toolCallId, delegationGroupId: 'group-stop', forkSnapshot: [] });
  try {
    const spawned = await manager.spawn({ task: 'blocked' }, caller('spawn')) as { agent_id: string };
    const stopped = await manager.stopSession(sessionId, 'emergency stop');
    assert.equal(stopped.stoppedAgents, 1);
    assert.equal(stopped.tree?.control.halted, true);
    assert.equal(stopped.tree?.runs.find((run) => run.agentId === spawned.agent_id)?.status, 'interrupted');
    assert.deepEqual(await store.pendingNotifications(sessionId), []);
    const blocked = await manager.followup({ agentId: spawned.agent_id, task: 'must not restart' }, caller('followup-blocked', 'main-after-stop')) as { code: string };
    assert.equal(blocked.code, 'session_halted');
    await manager.resumeSession(sessionId);
    const resumed = await manager.followup({ agentId: spawned.agent_id, task: 'resume' }, caller('followup-resumed', 'main-resumed')) as { status: string };
    assert.equal(resumed.status, 'running');
    await manager.wait({ agentIds: [spawned.agent_id], block: true, timeoutMs: 1_000 }, caller('wait-resumed', 'main-resumed'));
    assert.equal((await manager.list(sessionId))?.control.halted, false);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('historical built-in Agents inherit current safety budgets on follow-up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-budget-upgrade-'));
  const sessionId = 'session-budget-upgrade';
  const store = createAgentStore({ sessionsDir: root });
  const definitions = createAgentDefinitionRegistry();
  const { agent, run } = records(sessionId);
  agent.definitionSnapshot.budget = { maxModelTurns: 200, maxRetriesPerTurn: 1, maxOutputTokens: 16_384, maxResultBytes: 64 * 1024 };
  let observedBudget: AgentRecord['definitionSnapshot']['budget'] | undefined;
  const runChild = async (input: Parameters<Parameters<typeof createAgentManager>[0]['runChild']>[0]): Promise<AgentRunResult> => {
    observedBudget = input.agent.definitionSnapshot.budget;
    const now = new Date().toISOString();
    return {
      runId: input.run.agentRunId, parentRunId: input.run.invokedByRunId, profile: 'child', origin: 'orchestrated', status: 'completed', terminationReason: 'natural_completion', finalContent: 'done',
      messages: [], modelTurnCount: 1, modelAttemptCount: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, unknown: 0 }, toolsUsed: [], filesModified: [], fileChanges: [], skillsUsed: [],
      contextSummaryUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, contextRefreshWarnings: [], runtimeWarnings: [], startedAt: now, completedAt: now, durationMs: 1,
    };
  };
  try {
    await store.createAgentRun(sessionId, agent, run, 'main-1:spawn-old');
    const completedAt = new Date().toISOString();
    await store.append(sessionId, [{
      type: 'agent_run_terminal', agentId: agent.agentId, agentRunId: run.agentRunId, status: 'failed', completedAt,
      result: { status: 'failed', terminationReason: 'model_failure', finalContent: '', toolsUsed: [], filesModified: [], error: { code: 'MODEL_TIMEOUT', message: 'old timeout' } },
    }]);
    const manager = createAgentManager({ enabled: true, store, definitions, runChild });
    const caller = { sessionId, callerRunId: 'main-new', callerTurn: 1, toolCallId: 'followup-new', delegationGroupId: 'group-new', forkSnapshot: [] };
    await manager.followup({ agentId: agent.agentId, task: 'retry safely' }, caller);
    await manager.wait({ agentIds: [agent.agentId], block: true, timeoutMs: 1_000 }, { ...caller, toolCallId: 'wait-new' });
    assert.equal(observedBudget?.maxModelTurns, 64);
    assert.equal(observedBudget?.modelRequestTimeoutMs, 300_000);
    assert.equal(observedBudget?.maxRunDurationMs, 900_000);
    assert.equal(observedBudget?.maxTotalTokens, 1_500_000);
    await manager.shutdown();
  } finally { await rm(root, { recursive: true, force: true }); }
});
