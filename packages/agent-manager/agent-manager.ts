import type { ChatMessage, ToolCall } from '../shared/types.ts';
import type { AgentPersistenceHooks, AgentRunResult } from '../agent-core/agent-runtime.ts';
import type { AgentDefinitionRegistry } from './agent-definitions.ts';
import type { AgentStore } from './agent-store.ts';
import {
  type AgentCallerContext,
  type AgentCompletionNotification,
  type AgentContextMode,
  type AgentDefinition,
  type AgentIsolation,
  type AgentOrchestrationPort,
  type AgentRecord,
  type AgentRunRecord,
  type AgentToolRecord,
  type AgentTreeSnapshot,
  type StoredAgentRunResult,
  DEFAULT_AGENT_DEFINITION_NAME,
} from './contracts.ts';
import { AgentManagerError, agentErrorResult } from './errors.ts';
import { createHash } from 'node:crypto';

type ChildRunInput = {
  sessionId: string;
  agent: AgentRecord;
  run: AgentRunRecord;
  messages: ChatMessage[];
  persistenceHooks: AgentPersistenceHooks;
  signal: AbortSignal;
};

type Handle = { sessionId: string; agentId: string; agentRunId: string; abortController: AbortController; promise: Promise<StoredAgentRunResult> };

const WRITE_TOOLS = new Set(['write_file', 'patch_file', 'run_command']);
const BUILTIN_AGENT_NAMES = new Set(['general-writer', 'general-reader', 'general-purpose', 'assistant', 'researcher', 'reviewer']);
const MODEL_HIDDEN_AGENT_NAMES = new Set(['general-purpose', 'assistant']);

function definitionIsWriter(definition: AgentDefinition): boolean {
  const allow = definition.toolPolicy.allow ?? [];
  return allow.some((tool) => WRITE_TOOLS.has(tool));
}

function isWriter(agent: AgentRecord): boolean {
  return definitionIsWriter(agent.definitionSnapshot);
}

function storedResult(result: AgentRunResult): StoredAgentRunResult {
  return {
    status: result.status === 'aborted' ? 'interrupted' : result.status,
    terminationReason: result.terminationReason,
    finalContent: result.finalContent,
    usage: result.usage,
    toolsUsed: result.toolsUsed,
    filesModified: result.filesModified,
    fileChanges: result.fileChanges,
    ...(result.error ? { error: result.error } : {}),
  };
}

function resultView(run: AgentRunRecord, maxBytes: number) {
  if (!run.result) return { agent_run_id: run.agentRunId, status: run.status };
  const content = new TextEncoder().encode(run.result.finalContent);
  const truncated = content.byteLength > maxBytes;
  return {
    agent_run_id: run.agentRunId,
    status: run.status,
    result: {
      ...run.result,
      finalContent: truncated ? new TextDecoder().decode(content.slice(0, maxBytes)) : run.result.finalContent,
      ...(truncated ? { truncated: true, totalBytes: content.byteLength } : {}),
    },
  };
}

function boundedText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  return { text: new TextDecoder().decode(bytes.slice(0, maxBytes)), truncated: true };
}

function completionNotification(agent: AgentRecord, run: AgentRunRecord, result: StoredAgentRunResult, completedAt: string): AgentCompletionNotification {
  const maxBytes = Math.min(agent.definitionSnapshot.budget.maxResultBytes ?? 64 * 1024, 64 * 1024);
  const bounded = boundedText(result.finalContent, maxBytes);
  const summaryText = boundedText(result.finalContent.trim() || result.error?.message || `${result.status}: ${result.terminationReason}`, 4 * 1024).text;
  return {
    notificationId: `notification-${run.agentRunId}`,
    agentId: agent.agentId,
    agentRunId: run.agentRunId,
    ...(run.delegationGroupId ? { delegationGroupId: run.delegationGroupId } : {}),
    createdAt: completedAt,
    status: 'pending',
    summary: summaryText,
    result: {
      status: result.status,
      terminationReason: result.terminationReason,
      finalContent: bounded.text,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(bounded.truncated ? { error: result.error ?? { code: 'RESULT_TRUNCATED', message: `Result truncated to ${maxBytes} bytes` } } : {}),
    },
  };
}

export function multiAgentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.MULTI_AGENT_ENABLED?.trim().toLowerCase();
  if (value === undefined || value === '') return true;
  if (['1', 'true', 'on'].includes(value)) return true;
  if (['0', 'false', 'off'].includes(value)) return false;
  throw new Error('MULTI_AGENT_ENABLED must be true or false');
}

export function createAgentManager(options: {
  enabled: boolean;
  store: AgentStore;
  definitions: AgentDefinitionRegistry;
  runChild(input: ChildRunInput): Promise<AgentRunResult>;
  limits?: { maxConcurrentAgents?: number; maxAgentsPerSession?: number; maxAgentRecordsPerSession?: number; maxDepth?: number; maxConcurrentSharedWriters?: number; maxOrchestrationOpsPerRun?: number; maxStalledOrchestrationOps?: number };
}): AgentOrchestrationPort & {
  list(sessionId: string): Promise<AgentTreeSnapshot | null>;
  detail(sessionId: string, agentId: string): Promise<{ agent: AgentRecord; runs: AgentRunRecord[]; messages: ChatMessage[]; tools: AgentToolRecord[] } | null>;
  stopSession(sessionId: string, reason?: string): Promise<{ stoppedAgents: number; pendingNotificationsConsumed: number; tree: AgentTreeSnapshot | null }>;
  resumeSession(sessionId: string): Promise<AgentTreeSnapshot | null>;
  shutdown(reason?: string): Promise<void>;
} {
  const limits = {
    maxConcurrentAgents: options.limits?.maxConcurrentAgents ?? 4,
    maxAgentsPerSession: options.limits?.maxAgentsPerSession ?? 8,
    maxAgentRecordsPerSession: options.limits?.maxAgentRecordsPerSession ?? 64,
    maxDepth: options.limits?.maxDepth ?? 1,
    maxConcurrentSharedWriters: options.limits?.maxConcurrentSharedWriters ?? 1,
    maxOrchestrationOpsPerRun: options.limits?.maxOrchestrationOpsPerRun ?? 32,
    maxStalledOrchestrationOps: options.limits?.maxStalledOrchestrationOps ?? 3,
  };
  const modelVisibleDefinitions = () => options.definitions.list()
    .filter(({ name }) => !MODEL_HIDDEN_AGENT_NAMES.has(name));
  const handles = new Map<string, Handle>();
  const locks = new Map<string, Promise<void>>();
  const recoveredSessions = new Set<string>();
  const callerGuards = new Map<string, { sessionId: string; operations: number; lastRevision?: number; stalledOperations: number; observedTerminalRuns: Set<string>; circuitOpen: boolean }>();

  const requireEnabled = () => { if (!options.enabled) throw new AgentManagerError('feature_disabled', 'Multi-Agent is disabled'); };
  const withAgentLock = async <T>(agentId: string, action: () => Promise<T>): Promise<T> => {
    const previous = locks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    locks.set(agentId, queued);
    await previous;
    try { return await action(); } finally { release(); if (locks.get(agentId) === queued) locks.delete(agentId); }
  };
  const loadTree = async (sessionId: string) => {
    const recover = !recoveredSessions.has(sessionId);
    recoveredSessions.add(sessionId);
    return options.store.load(sessionId, recover);
  };
  const treeFor = async (sessionId: string) => {
    const tree = await loadTree(sessionId);
    if (!tree) throw new AgentManagerError('not_found', 'This Session has no child agents');
    return tree;
  };
  const findAgent = async (sessionId: string, agentId: string) => {
    const tree = await treeFor(sessionId);
    const agent = tree.agents.find((item) => item.agentId === agentId);
    if (!agent) throw new AgentManagerError('not_found', `Agent not found: ${agentId}`);
    return { tree, agent };
  };
  const callerGuard = (caller: AgentCallerContext) => {
    let guard = callerGuards.get(caller.callerRunId);
    if (!guard) {
      guard = { sessionId: caller.sessionId, operations: 0, stalledOperations: 0, observedTerminalRuns: new Set(), circuitOpen: false };
      callerGuards.set(caller.callerRunId, guard);
      while (callerGuards.size > 128) callerGuards.delete(callerGuards.keys().next().value!);
    }
    return guard;
  };
  const orchestrationPreflight = async (caller: AgentCallerContext) => {
    const tree = await loadTree(caller.sessionId);
    if (tree?.control.halted) {
      return { status: 'blocked', code: 'session_halted', message: 'Multi-Agent orchestration is halted for this Session. A new user Run must explicitly resume it.' };
    }
    const guard = callerGuard(caller);
    guard.operations += 1;
    if (guard.lastRevision === tree?.revision) guard.stalledOperations += 1;
    else guard.stalledOperations = 0;
    guard.lastRevision = tree?.revision;
    if (guard.operations > limits.maxOrchestrationOpsPerRun || guard.stalledOperations >= limits.maxStalledOrchestrationOps) {
      guard.circuitOpen = true;
    }
    if (!guard.circuitOpen) return undefined;
    return {
      status: 'circuit_open',
      code: 'orchestration_stalled',
      orchestration_circuit_open: true,
      operations: guard.operations,
      stalled_operations: guard.stalledOperations,
      revision: tree?.revision ?? 0,
      message: 'Multi-Agent orchestration stopped because it exceeded its operation budget or made no state progress. Do not call orchestration tools again in this Run.',
    };
  };

  const launch = (agent: AgentRecord, run: AgentRunRecord, initialMessages: ChatMessage[]): Handle => {
    const abortController = new AbortController();
    const currentBuiltin = BUILTIN_AGENT_NAMES.has(agent.definitionName) ? options.definitions.resolve(agent.definitionName)?.definition : undefined;
    const effectiveAgent = currentBuiltin
      ? { ...agent, definitionSnapshot: { ...agent.definitionSnapshot, budget: { ...agent.definitionSnapshot.budget, ...currentBuiltin.budget } } }
      : agent;
    const maxRunDurationMs = effectiveAgent.definitionSnapshot.budget.maxRunDurationMs;
    const durationTimer = maxRunDurationMs === undefined ? undefined : setTimeout(() => {
      abortController.abort(`Agent Run exceeded maxRunDurationMs (${maxRunDurationMs})`);
    }, maxRunDurationMs);
    const persistenceHooks: AgentPersistenceHooks = {
      assistantCommitted: (message) => options.store.append(agent.sessionId, [{ type: 'agent_message_committed', agentId: agent.agentId, agentRunId: run.agentRunId, message }]).then(() => undefined),
      toolStarted: (call: ToolCall) => {
        let input: Record<string, unknown> | undefined;
        try { input = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { input = undefined; }
        return options.store.append(agent.sessionId, [{
          type: 'agent_tool_started', agentId: agent.agentId, agentRunId: run.agentRunId,
          tool: { callId: call.id, name: call.function.name, ...(input ? { input } : {}), status: 'running' },
        }]).then(() => undefined);
      },
      toolOutcome: (message, presentation) => options.store.append(agent.sessionId, [
        { type: 'agent_message_committed', agentId: agent.agentId, agentRunId: run.agentRunId, message },
        { type: 'agent_tool_finished', agentId: agent.agentId, agentRunId: run.agentRunId, callId: message.tool_call_id, presentation },
      ]).then(() => undefined),
      usageUpdated: (usage) => options.store.append(agent.sessionId, [
        { type: 'agent_run_usage', agentId: agent.agentId, agentRunId: run.agentRunId, usage },
      ]).then(() => undefined),
    };
    const promise = (async () => {
      let result: StoredAgentRunResult;
      try {
        result = storedResult(await options.runChild({ sessionId: agent.sessionId, agent: effectiveAgent, run, messages: initialMessages, persistenceHooks, signal: abortController.signal }));
      } catch (error) {
        result = {
          status: abortController.signal.aborted ? 'interrupted' : 'failed',
          terminationReason: abortController.signal.aborted ? 'user_abort' : 'model_failure',
          finalContent: '', toolsUsed: [], filesModified: [],
          error: { code: 'CHILD_RUN_FAILURE', message: error instanceof Error ? error.message : String(error) },
        };
      }
      if (durationTimer) clearTimeout(durationTimer);
      const completedAt = new Date().toISOString();
      const beforeTerminal = await options.store.load(agent.sessionId, false);
      await options.store.append(agent.sessionId, [
        { type: 'agent_run_terminal', agentId: agent.agentId, agentRunId: run.agentRunId, status: result.status, result, completedAt },
        ...(!beforeTerminal?.control.halted
          ? [{ type: 'agent_completion_notification' as const, notification: completionNotification(agent, run, result, completedAt) }]
          : []),
      ]);
      handles.delete(agent.agentId);
      return result;
    })();
    const handle = { sessionId: agent.sessionId, agentId: agent.agentId, agentRunId: run.agentRunId, abortController, promise };
    handles.set(agent.agentId, handle);
    return handle;
  };

  async function spawnRaw(input: { task: string; agent?: string; contextMode?: AgentContextMode; name?: string; isolation?: AgentIsolation }, caller: AgentCallerContext) {
    requireEnabled();
    const blocked = await orchestrationPreflight(caller);
    if (blocked) return blocked;
    if (caller.callerAgentId && limits.maxDepth <= 1) throw new AgentManagerError('depth_exceeded', 'Child agents cannot spawn recursively');
    const existing = await loadTree(caller.sessionId);
    const replay = existing?.operations[`${caller.callerRunId}:${caller.toolCallId}`];
    if (replay?.agentRunId) return { agent_id: replay.agentId, agent_run_id: replay.agentRunId, status: 'running', replayed: true };
    if ((existing?.agents.filter((item) => item.createdByRunId === caller.callerRunId).length ?? 0) >= limits.maxAgentsPerSession) throw new AgentManagerError('capacity_exceeded', 'Main Run child-agent capacity is exhausted');
    if ((existing?.agents.length ?? 0) >= limits.maxAgentRecordsPerSession) throw new AgentManagerError('history_capacity_exceeded', 'Session child-agent history capacity is exhausted');
    if (handles.size >= limits.maxConcurrentAgents) throw new AgentManagerError('capacity_exceeded', 'Concurrent child-agent capacity is exhausted');
    const requestedDefinition = input.agent?.trim() || DEFAULT_AGENT_DEFINITION_NAME;
    const resolved = options.definitions.resolve(requestedDefinition);
    if (!resolved) {
      const available = modelVisibleDefinitions().map((definition) => definition.name).sort();
      throw new AgentManagerError('definition_not_found', `Agent definition not found: ${requestedDefinition}. Available agents: ${available.join(', ') || 'none'}`);
    }
    const contextMode = input.contextMode ?? resolved.definition.defaultContextMode;
    if (!resolved.definition.allowedContextModes.includes(contextMode)) throw new AgentManagerError('context_mode_forbidden', `Context mode ${contextMode} is not allowed`);
    const isolation = input.isolation ?? resolved.definition.isolationPolicy.default;
    if (!resolved.definition.isolationPolicy.allowed.includes(isolation)) throw new AgentManagerError('isolation_forbidden', `Isolation ${isolation} is not allowed`);
    const now = new Date().toISOString();
    const agentId = `agent-${crypto.randomUUID()}`;
    const agentRunId = `agent-run-${crypto.randomUUID()}`;
    const rootAgentId = existing?.rootAgentId ?? `agent-root-${caller.sessionId.slice('session-'.length)}`;
    const agent: AgentRecord = {
      agentId, sessionId: caller.sessionId, rootAgentId, parentAgentId: caller.callerAgentId ?? rootAgentId,
      createdByRunId: caller.callerRunId, name: input.name?.trim() || resolved.definition.name, task: input.task,
      contextMode, isolation, definitionName: resolved.definition.name, definitionDigest: resolved.digest,
      definitionSnapshot: resolved.definition, contextSeed: contextMode === 'fork' ? structuredClone(caller.forkSnapshot) : [],
      status: 'running', currentRunId: agentRunId, lastRunId: agentRunId, createdAt: now, updatedAt: now,
    };
    if (isWriter(agent) && [...handles.values()].filter((handle) => {
      const running = existing?.agents.find((item) => item.agentId === handle.agentId);
      return running?.isolation === 'shared' && isWriter(running);
    }).length >= limits.maxConcurrentSharedWriters) throw new AgentManagerError('write_capacity_exceeded', 'A shared-workspace writer is already running');
    const run: AgentRunRecord = {
      agentRunId, agentId, invokedByRunId: caller.callerRunId, invokedByTurn: caller.callerTurn,
      invokedByToolCallId: caller.toolCallId, delegationGroupId: caller.delegationGroupId,
      trigger: 'spawn', status: 'running', input: input.task, startedAt: now,
    };
    await options.store.createAgentRun(caller.sessionId, agent, run, `${caller.callerRunId}:${caller.toolCallId}`);
    launch(agent, run, [...agent.contextSeed, { role: 'user', content: input.task }]);
    return {
      agent_id: agentId, agent_run_id: agentRunId, status: 'running', asynchronous: true,
      message: 'Child agent started asynchronously. Choose foreground wait_agent(block=true) if this Main Run needs the result, or continue independent work and allow background completion delivery. Foreground waits yield to user Steer; do not tight-poll.',
    };
  }

  async function followupRaw(input: { agentId: string; task: string }, caller: AgentCallerContext) {
    requireEnabled();
    const blocked = await orchestrationPreflight(caller);
    if (blocked) return blocked;
    return withAgentLock(input.agentId, async () => {
      const { tree, agent } = await findAgent(caller.sessionId, input.agentId);
      if (agent.currentRunId || handles.has(agent.agentId)) throw new AgentManagerError('agent_busy', `Agent is already running: ${agent.agentId}`);
      const operationId = `${caller.callerRunId}:${caller.toolCallId}`;
      const replay = tree.operations[operationId];
      if (replay?.agentRunId) return { agent_id: replay.agentId, agent_run_id: replay.agentRunId, status: 'running', replayed: true };
      const now = new Date().toISOString();
      const run: AgentRunRecord = {
        agentRunId: `agent-run-${crypto.randomUUID()}`, agentId: agent.agentId,
        invokedByRunId: caller.callerRunId, invokedByTurn: caller.callerTurn,
        invokedByToolCallId: caller.toolCallId, delegationGroupId: caller.delegationGroupId,
        trigger: 'followup', status: 'running', input: input.task, startedAt: now,
      };
      const next = await options.store.append(caller.sessionId, [
        { type: 'agent_run_started', run, operationId },
        { type: 'agent_context_committed', context: {
          owner: { kind: 'agent', sessionId: caller.sessionId, agentId: agent.agentId }, agentRunId: run.agentRunId, mode: agent.contextMode,
          seedMessageCount: tree.conversations.find((item) => item.agentId === agent.agentId)?.messages.length ?? 0,
          seedDigest: `sha256-${createHash('sha256').update(JSON.stringify(tree.conversations.find((item) => item.agentId === agent.agentId)?.messages ?? [])).digest('hex')}`,
          committedAt: now,
        } },
        { type: 'agent_message_committed', agentId: agent.agentId, agentRunId: run.agentRunId, message: { role: 'user', content: input.task } },
      ]);
      const messages = next.conversations.find((item) => item.agentId === agent.agentId)?.messages ?? [{ role: 'user', content: input.task }];
      launch(agent, run, messages);
      return {
        agent_id: agent.agentId, agent_run_id: run.agentRunId, status: 'running', asynchronous: true,
        message: 'Child agent follow-up started asynchronously. Choose foreground wait_agent(block=true) if this Main Run needs the result, or allow background completion delivery. Foreground waits yield to user Steer; do not tight-poll.',
      };
    });
  }

  async function stopRaw(input: { agentId: string; reason?: string }, caller: AgentCallerContext) {
    requireEnabled();
    const blocked = await orchestrationPreflight(caller);
    if (blocked) return blocked;
    const { agent } = await findAgent(caller.sessionId, input.agentId);
    const handle = handles.get(agent.agentId);
    if (!handle || !agent.currentRunId) return { agent_id: agent.agentId, status: 'already_idle' };
    await options.store.append(caller.sessionId, [{ type: 'agent_stop_requested', agentId: agent.agentId, agentRunId: handle.agentRunId, ...(input.reason ? { reason: input.reason } : {}) }]);
    handle.abortController.abort(input.reason ?? 'Stopped by parent Agent');
    return { agent_id: agent.agentId, agent_run_id: handle.agentRunId, status: 'stopped' };
  }

  async function waitRaw(input: { agentIds: string[]; mode?: 'any' | 'all'; block?: boolean; timeoutMs?: number }, caller: AgentCallerContext) {
    requireEnabled();
    const blocked = await orchestrationPreflight(caller);
    if (blocked) return blocked;
    const tree = await treeFor(caller.sessionId);
    const targets = input.agentIds.map((agentId) => {
      const agent = tree.agents.find((item) => item.agentId === agentId);
      if (!agent) throw new AgentManagerError('not_found', `Agent not found: ${agentId}`);
      const runId = agent.currentRunId ?? agent.lastRunId;
      const run = tree.runs.find((item) => item.agentRunId === runId);
      if (!run) throw new AgentManagerError('not_found', `Agent has no Run: ${agentId}`);
      return { agent, run, handle: handles.get(agentId) };
    });
    const mode = input.mode ?? 'all';
    const block = input.block ?? false;
    const timeoutMs = input.timeoutMs ?? 60_000;
    const waitable = targets.filter((target) => target.run.status === 'running' && target.handle?.agentRunId === target.run.agentRunId);
    let timedOut = false;
    let cancelled = false;
    if (block && waitable.length > 0 && timeoutMs > 0 && !caller.signal?.aborted) {
      const completion = mode === 'any'
        ? Promise.race(waitable.map((item) => item.handle!.promise))
        : Promise.all(waitable.map((item) => item.handle!.promise));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        if (!caller.signal) return;
        onAbort = () => { cancelled = true; resolve(); };
        caller.signal.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([completion, aborted, new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]);
      if (timer) clearTimeout(timer);
      if (onAbort) caller.signal?.removeEventListener('abort', onAbort);
    } else if (block && waitable.length > 0) {
      cancelled = Boolean(caller.signal?.aborted);
      timedOut = !cancelled;
    }
    const latest = (await options.store.load(caller.sessionId, false))!;
    const guard = callerGuard(caller);
    const newlyObservedRunIds: string[] = [];
    const completed = targets.flatMap(({ agent, run }) => {
      const current = latest.runs.find((item) => item.agentRunId === run.agentRunId)!;
      if (current.status === 'running' || guard.observedTerminalRuns.has(current.agentRunId)) return [];
      guard.observedTerminalRuns.add(current.agentRunId);
      newlyObservedRunIds.push(current.agentRunId);
      return [{ agent_id: agent.agentId, ...resultView(current, agent.definitionSnapshot.budget.maxResultBytes ?? 64 * 1024) }];
    });
    const deliveredNotifications = latest.inbox.filter((item) => item.status === 'pending' && newlyObservedRunIds.includes(item.agentRunId));
    const delivered = deliveredNotifications.length > 0
      ? (await options.store.consumeNotifications(caller.sessionId, deliveredNotifications.map((item) => item.notificationId), caller.callerRunId))!
      : latest;
    const running = targets.filter(({ run }) => delivered.runs.find((item) => item.agentRunId === run.agentRunId)?.status === 'running').map(({ agent, run }) => ({ agent_id: agent.agentId, agent_run_id: run.agentRunId }));
    return {
      status: completed.length > 0 ? 'settled' : running.length > 0 ? 'running' : 'no_change',
      mode, block, timed_out: timedOut, cancelled, completed, running,
      settled: running.length === 0,
      ...(completed.length === 0 && running.length === 0 ? { code: 'already_observed', message: 'All selected Agent Runs are terminal and their results were already delivered to this caller. There is no new progress to wait for.' } : {}),
      revision: delivered.revision,
    };
  }

  return {
    definitions: () => modelVisibleDefinitions().map((definition) => ({
      name: definition.name,
      description: definition.description,
      filePermission: definitionIsWriter(definition) ? 'write_files' : 'read_only',
    })),
    spawn: async (input, caller) => {
      try { return await withAgentLock(`operation:${caller.sessionId}:${caller.callerRunId}:${caller.toolCallId}`, () => spawnRaw(input, caller)); }
      catch (error) { return agentErrorResult(error); }
    },
    wait: async (input, caller) => { try { return await waitRaw(input, caller); } catch (error) { return agentErrorResult(error); } },
    followup: async (input, caller) => { try { return await followupRaw(input, caller); } catch (error) { return agentErrorResult(error); } },
    stop: async (input, caller) => { try { return await stopRaw(input, caller); } catch (error) { return agentErrorResult(error); } },
    list: (sessionId) => loadTree(sessionId),
    async detail(sessionId, agentId) {
      const tree = await loadTree(sessionId);
      const agent = tree?.agents.find((item) => item.agentId === agentId);
      if (!tree || !agent) return null;
      const conversation = tree.conversations.find((item) => item.agentId === agentId);
      return {
        agent,
        runs: tree.runs.filter((run) => run.agentId === agentId),
        messages: conversation?.messages ?? [],
        tools: conversation?.tools ?? [],
      };
    },
    async stopSession(sessionId, reason = 'Session is closing') {
      await options.store.haltSession(sessionId, reason);
      const sessionHandles = [...handles.values()].filter((handle) => handle.sessionId === sessionId);
      for (const handle of sessionHandles) handle.abortController.abort(reason);
      await Promise.allSettled(sessionHandles.map((handle) => handle.promise));
      const pending = (await options.store.load(sessionId, false))?.inbox.filter((item) => item.status === 'pending') ?? [];
      const tree = pending.length > 0
        ? await options.store.consumeNotifications(sessionId, pending.map((item) => item.notificationId), `session-stop:${reason}`)
        : await options.store.load(sessionId, false);
      for (const [runId, guard] of callerGuards) if (guard.sessionId === sessionId) callerGuards.delete(runId);
      return { stoppedAgents: sessionHandles.length, pendingNotificationsConsumed: pending.length, tree };
    },
    async resumeSession(sessionId) {
      return options.store.resumeSession(sessionId);
    },
    async shutdown(reason = 'Runtime is shutting down') {
      const active = [...handles.values()];
      for (const handle of active) handle.abortController.abort(reason);
      await Promise.allSettled(active.map((handle) => handle.promise));
    },
  };
}

export type AgentManager = ReturnType<typeof createAgentManager>;
