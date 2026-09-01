import type { AgentEvent, QueueDelivery, QueueItemView, QueuePauseReason, RunContext, Session, TaskSummary } from '../shared/types.ts';
import type { ExecutorHooks } from './executor.ts';
import type { AgentLifecycleHooks, AgentOrigin, AgentRunBudget } from './agent-runtime.ts';
import type { QueueMutationOutcome, SessionRepository } from './session-contracts.ts';
import type { RunCommandSource } from './run-commands.ts';
import type { RunEventEnvelope, RunEventPayload } from '../run-protocol/contracts.ts';

export type ActiveRunPhase = 'accepting_commands' | 'waiting_confirm' | 'closing' | 'stopping' | 'terminal';

type AgentRunner = {
  runTask(
    sessionId: string,
    prompt: string,
    selectedFile: string | null,
    onEvent: (event: AgentEvent) => void,
    hooks: ExecutorHooks,
    options: {
      runId: string;
      signal: AbortSignal;
      prestarted: boolean;
      isNew?: boolean;
      clientRequestId?: string;
      sourceItemId?: string;
      commandSource: RunCommandSource;
      beforeFinish?: (result: { status: TaskSummary['status'] }) => Promise<void>;
      onRunEvent?: (event: RunEventEnvelope) => void;
      legacyEvents?: boolean;
      presentationHooks?: (emit: (event: RunEventPayload) => void) => ExecutorHooks;
      lifecycle?: AgentLifecycleHooks;
      origin?: AgentOrigin;
      budget?: AgentRunBudget;
    },
  ): Promise<TaskSummary>;
};

type RunEnvironment = { agent: AgentRunner; context: RunContext };
type EventSink = (event: AgentEvent) => void;
type AgentInboxNotification = {
  notificationId: string;
  agentId: string;
  agentRunId: string;
  delegationGroupId?: string;
  createdAt: string;
  summary: string;
  result: { status: string; terminationReason: string; finalContent: string; usage?: unknown; error?: { code: string; message: string } };
};
type AgentInboxBatch = { notifications: AgentInboxNotification[]; message: { role: 'user'; content: string }; origin: string };
export type CoordinatorStreamOptions = {
  onRunEvent?: (event: RunEventEnvelope) => void;
  legacyEvents?: boolean;
};

type ActiveConversationRun = {
  sessionId: string;
  runId: string;
  phase: ActiveRunPhase;
  abortController: AbortController;
  sink: EventSink;
  stoppedFor?: QueuePauseReason;
};

type ConversationRunChain = {
  chainId: string;
  sessionId: string;
  sink: EventSink;
  stoppedFor?: QueuePauseReason;
};

export type StartConversationRunInput = {
  sessionId: string;
  runId: string;
  prompt: string;
  prestarted: boolean;
  isNew?: boolean;
  clientRequestId?: string;
  sourceItemId?: string;
  notificationDelivery?: boolean;
};

export type SubmitDuringRunInput = {
  sessionId: string;
  content: string;
  delivery: QueueDelivery;
  operationId: string;
  expectedRunId?: string;
  expectedSessionRevision?: number;
};

export type QueueCommand =
  | { type: 'promote_to_steer'; sessionId: string; itemId: string; expectedRunId: string; operationId: string; expectedSessionRevision?: number }
  | { type: 'cancel'; sessionId: string; itemId: string; operationId: string; expectedSessionRevision?: number }
  | { type: 'reorder'; sessionId: string; orderedItemIds: string[]; operationId: string; expectedSessionRevision: number };

export type ConversationRuntimeSnapshot = {
  activeRun?: { runId: string; phase: ActiveRunPhase };
  queuedItems: QueueItemView[];
  queuePaused: boolean;
  sessionRevision: number;
};

export type RunChainResult = { summaries: TaskSummary[]; paused: boolean };

export type QueueObservation = {
  metric: 'queue.enqueue.count' | 'queue.promote.count' | 'queue.cancel.count' | 'queue.pending.count' | 'queue.wait_ms' | 'steer.safe_boundary_wait_ms' | 'steer.requeued.count' | 'run_chain.length' | 'run_chain.paused.count' | 'queue.idempotent_replay.count';
  value: number;
  sessionId: string;
  runId?: string;
  itemId?: string;
  operationId?: string;
  delivery?: QueueDelivery;
  outcome?: string;
  reason?: string;
};

export function createConversationRunCoordinator(dependencies: {
  repository: SessionRepository;
  resolveEnvironment(session: Session): Promise<RunEnvironment>;
  createHooks(sessionId: string, runId: string, sink: EventSink, emit?: (event: RunEventPayload) => void): ExecutorHooks;
  createLifecycleHooks?(sessionId: string, runId: string): AgentLifecycleHooks;
  cancelPending?(sessionId: string, runId: string, reason: QueuePauseReason): void;
  agentInbox?: {
    pending(sessionId: string): Promise<AgentInboxNotification[]>;
    consume(sessionId: string, notificationIds: string[], consumedByRunId: string): Promise<unknown>;
  };
  observe?(observation: QueueObservation): void;
}) {
  const { repository } = dependencies;
  const activeByRunId = new Map<string, ActiveConversationRun>();
  const activeBySessionId = new Map<string, ActiveConversationRun>();
  const chainsBySessionId = new Map<string, ConversationRunChain>();
  const locks = new Map<string, Promise<void>>();
  const observe = (observation: QueueObservation) => dependencies.observe?.(observation);
  const MAX_CONSECUTIVE_AGENT_NOTIFICATION_RUNS = 4;
  const AGENT_NOTIFICATION_BUDGET: AgentRunBudget = {
    maxModelTurns: 20,
    maxModelAttempts: 24,
    maxRetriesPerTurn: 1,
    maxOutputTokens: 16_384,
    modelRequestTimeoutMs: 300_000,
    maxTotalTokens: 1_000_000,
  };

  function notificationIdsFromOrigin(origin: string | undefined): string[] {
    return origin?.startsWith('agent_notification:') ? origin.slice('agent_notification:'.length).split(',').filter(Boolean) : [];
  }

  async function pendingAgentBatch(sessionId: string): Promise<AgentInboxBatch | null> {
    if (!dependencies.agentInbox) return null;
    let pending = await dependencies.agentInbox.pending(sessionId);
    if (pending.length === 0) return null;
    const session = await repository.loadSession(sessionId);
    if (!session) return null;
    const delivered = new Map<string, string>();
    for (const record of session.ledger ?? []) {
      const ids = notificationIdsFromOrigin(record.type === 'run_started' || record.type === 'message' ? record.origin : undefined);
      for (const id of ids) delivered.set(id, 'runId' in record ? record.runId : 'recovered');
    }
    const alreadyDelivered = pending.filter((item) => delivered.has(item.notificationId));
    if (alreadyDelivered.length > 0) {
      const byRun = new Map<string, string[]>();
      for (const item of alreadyDelivered) {
        const runId = delivered.get(item.notificationId)!;
        byRun.set(runId, [...(byRun.get(runId) ?? []), item.notificationId]);
      }
      for (const [runId, ids] of byRun) await dependencies.agentInbox.consume(sessionId, ids, runId);
      pending = await dependencies.agentInbox.pending(sessionId);
      if (pending.length === 0) return null;
    }
    pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const first = pending[0]!;
    const groupKey = first.delegationGroupId ?? first.notificationId;
    const notifications = pending.filter((item) => (item.delegationGroupId ?? item.notificationId) === groupKey);
    const ids = notifications.map((item) => item.notificationId);
    const content = [
      'The following background child-agent runs completed. Incorporate the useful results, continue the parent task if needed, and do not claim they are still running.',
      JSON.stringify(notifications.map((item) => ({
        agentId: item.agentId,
        agentRunId: item.agentRunId,
        ...(item.delegationGroupId ? { delegationGroupId: item.delegationGroupId } : {}),
        status: item.result.status,
        terminationReason: item.result.terminationReason,
        summary: item.summary,
        result: item.result.finalContent,
        ...(item.result.usage ? { usage: item.result.usage } : {}),
        ...(item.result.error ? { error: item.result.error } : {}),
      }))),
    ].join('\n');
    return { notifications, message: { role: 'user', content }, origin: `agent_notification:${ids.join(',')}` };
  }

  async function beginAgentNotificationRun(sessionId: string, context: RunContext): Promise<{ runId: string; prompt: string; notificationDelivery: true } | null> {
    const batch = await pendingAgentBatch(sessionId);
    if (!batch || !dependencies.agentInbox) return null;
    const session = await repository.loadSession(sessionId);
    const consecutiveNotificationRuns = [...(session?.ledger ?? [])].reverse().reduce((count, record) => {
      if (count < 0 || record.type !== 'run_started') return count;
      return record.origin?.startsWith('agent_notification:') ? count + 1 : -1;
    }, 0);
    if (consecutiveNotificationRuns >= MAX_CONSECUTIVE_AGENT_NOTIFICATION_RUNS) {
      observe({ metric: 'run_chain.paused.count', value: 1, sessionId, outcome: 'agent_notification_limit', reason: 'agent_notification_limit' });
      return null;
    }
    const runId = crypto.randomUUID();
    await repository.beginRun({ sessionId, runId, userMessage: batch.message, context, profile: 'main', origin: batch.origin });
    await dependencies.agentInbox.consume(sessionId, batch.notifications.map((item) => item.notificationId), runId);
    return { runId, prompt: batch.message.content, notificationDelivery: true };
  }

  async function withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(sessionId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (locks.get(sessionId) === queued) locks.delete(sessionId);
    }
  }

  function register(handle: ActiveConversationRun) {
    if (activeBySessionId.has(handle.sessionId)) throw new Error(`Session already has active Run: ${handle.sessionId}`);
    activeBySessionId.set(handle.sessionId, handle);
    activeByRunId.set(handle.runId, handle);
  }

  function unregister(handle: ActiveConversationRun) {
    if (activeBySessionId.get(handle.sessionId) === handle) activeBySessionId.delete(handle.sessionId);
    if (activeByRunId.get(handle.runId) === handle) activeByRunId.delete(handle.runId);
    handle.phase = 'terminal';
  }

  function acceptingSteerTarget(handle: ActiveConversationRun | undefined, expectedRunId?: string): ActiveConversationRun | undefined {
    if (!handle || (handle.phase !== 'accepting_commands' && handle.phase !== 'waiting_confirm')) return undefined;
    return !expectedRunId || expectedRunId === handle.runId ? handle : undefined;
  }

  async function unregisterChain(chain: ConversationRunChain) {
    await withSessionLock(chain.sessionId, async () => {
      if (chainsBySessionId.get(chain.sessionId) === chain) chainsBySessionId.delete(chain.sessionId);
    });
  }

  function queueUpdated(sink: EventSink, sessionId: string, item: QueueItemView, sessionRevision: number) {
    sink({ type: 'queue_item_updated', sessionId, item, sessionRevision });
  }

  async function requeueAndPause(handle: ActiveConversationRun, reason: QueuePauseReason, status?: TaskSummary['status']) {
    const requeueReason = reason === 'disconnect'
      ? 'run_aborted'
      : status === 'limited'
        ? 'run_limited'
        : status === 'failed'
          ? 'run_failed'
          : 'run_aborted';
    const requeued = await repository.requeueSteers({
      sessionId: handle.sessionId,
      runId: handle.runId,
      reason: requeueReason,
      operationId: `terminal:${handle.runId}:requeue`,
    });
    for (const item of requeued.items) queueUpdated(handle.sink, handle.sessionId, item, requeued.sessionRevision);
    for (const item of requeued.items) observe({ metric: 'steer.requeued.count', value: 1, sessionId: handle.sessionId, runId: handle.runId, itemId: item.itemId, reason: requeueReason });
    const queue = await repository.getQueue(handle.sessionId);
    if (queue.pending.length > 0) {
      await repository.setQueuePaused({ sessionId: handle.sessionId, paused: true, reason, operationId: `terminal:${handle.runId}:pause:${reason}` });
      handle.sink({ type: 'run_chain_paused', sessionId: handle.sessionId, reason });
      observe({ metric: 'run_chain.paused.count', value: 1, sessionId: handle.sessionId, runId: handle.runId, reason });
    }
  }

  function commandSource(handle: ActiveConversationRun): RunCommandSource {
    return {
      atSafeBoundary(input) {
        return withSessionLock(handle.sessionId, async () => {
          if (activeBySessionId.get(handle.sessionId) !== handle || input.runId !== handle.runId || handle.phase === 'stopping' || handle.phase === 'terminal') {
            return { action: 'stop' } as const;
          }
          if (input.remainingModelTurns <= 0) {
            handle.phase = 'closing';
            const requeued = await repository.requeueSteers({
              sessionId: handle.sessionId,
              runId: handle.runId,
              reason: 'budget_exhausted',
              operationId: `budget:${handle.runId}:${input.remainingModelTurns}`,
            });
            for (const item of requeued.items) {
              queueUpdated(handle.sink, handle.sessionId, item, requeued.sessionRevision);
              observe({ metric: 'steer.requeued.count', value: 1, sessionId: handle.sessionId, runId: handle.runId, itemId: item.itemId, reason: 'budget_exhausted' });
            }
            return { action: 'proceed' } as const;
          }
          const consumed = await repository.consumeSteer({
            sessionId: handle.sessionId,
            runId: handle.runId,
            operationId: `steer:${handle.runId}:${crypto.randomUUID()}`,
          });
          if (consumed) {
            queueUpdated(handle.sink, handle.sessionId, consumed.item, consumed.sessionRevision);
            handle.sink({ type: 'user_message_committed', sessionId: handle.sessionId, runId: handle.runId, itemId: consumed.item.itemId });
            const waited = Math.max(0, Date.now() - Date.parse(consumed.item.createdAt));
            observe({ metric: 'queue.wait_ms', value: waited, sessionId: handle.sessionId, runId: handle.runId, itemId: consumed.item.itemId, delivery: 'steer' });
            observe({ metric: 'steer.safe_boundary_wait_ms', value: waited, sessionId: handle.sessionId, runId: handle.runId, itemId: consumed.item.itemId });
            return { action: 'continue', steer: consumed.message, itemId: consumed.item.itemId, directive: consumed.message.content } as const;
          }
          const queue = await repository.getQueue(handle.sessionId);
          if (!queue.pending.some((item) => item.delivery === 'next_run')) {
            const batch = await pendingAgentBatch(handle.sessionId);
            if (batch && dependencies.agentInbox) {
              await repository.appendRunMessage({
                sessionId: handle.sessionId,
                runId: handle.runId,
                message: batch.message,
                origin: batch.origin,
              });
              await dependencies.agentInbox.consume(handle.sessionId, batch.notifications.map((item) => item.notificationId), handle.runId);
              return {
                action: 'continue', steer: batch.message, itemId: batch.notifications[0]!.notificationId,
                directive: batch.message.content, refreshContext: false, updateActiveRequest: false,
              } as const;
            }
          }
          if (input.wouldNaturallyComplete) {
            handle.phase = 'closing';
            return { action: 'finish' } as const;
          }
          return { action: 'proceed' } as const;
        });
      },
    };
  }

  function observedSink(handle: ActiveConversationRun): EventSink {
    return (event) => {
      if ((event.type === 'confirm_request' || event.type === 'command_confirm_request' || event.type === 'approval_request') && event.taskId === handle.runId && handle.phase === 'accepting_commands') {
        handle.phase = 'waiting_confirm';
      } else if (event.type === 'task_status' && event.taskId === handle.runId) {
        if (event.status === 'waiting_confirm' && handle.phase === 'accepting_commands') handle.phase = 'waiting_confirm';
        else if (event.status === 'executing' && handle.phase === 'waiting_confirm') handle.phase = 'accepting_commands';
      }
      handle.sink(event);
    };
  }

  function runHooks(handle: ActiveConversationRun, sink: EventSink, emit?: (event: RunEventPayload) => void): ExecutorHooks {
    const hooks = dependencies.createHooks(handle.sessionId, handle.runId, sink, emit);
    const restore = () => {
      if (handle.phase === 'waiting_confirm') handle.phase = 'accepting_commands';
    };
    return {
      ...(hooks.onConfirm ? { onConfirm: async (...args: Parameters<NonNullable<ExecutorHooks['onConfirm']>>) => {
        try { return await hooks.onConfirm!(...args); } finally { restore(); }
      } } : {}),
      ...(hooks.onCommandConfirm ? { onCommandConfirm: async (...args: Parameters<NonNullable<ExecutorHooks['onCommandConfirm']>>) => {
        try { return await hooks.onCommandConfirm!(...args); } finally { restore(); }
      } } : {}),
      ...(hooks.onApproval ? { onApproval: async (...args: Parameters<NonNullable<ExecutorHooks['onApproval']>>) => {
        try { return await hooks.onApproval!(...args); } finally { restore(); }
      } } : {}),
    };
  }

  async function executeChain(first: StartConversationRunInput, sink: EventSink, chain: ConversationRunChain, stream: CoordinatorStreamOptions = {}): Promise<RunChainResult> {
    const summaries: TaskSummary[] = [];
    let current = first;
    while (true) {
      const session = await repository.loadSession(current.sessionId);
      if (!session) throw new Error(`Session not found: ${current.sessionId}`);
      const environment = await dependencies.resolveEnvironment(session);
      const handle: ActiveConversationRun = {
        sessionId: current.sessionId,
        runId: current.runId,
        phase: 'accepting_commands',
        abortController: new AbortController(),
        sink,
      };
      if (chain.stoppedFor) {
        handle.phase = 'stopping';
        handle.stoppedFor = chain.stoppedFor;
        handle.abortController.abort(chain.stoppedFor);
      }
      await withSessionLock(current.sessionId, async () => register(handle));
      sink({ type: 'run_started', sessionId: current.sessionId, runId: current.runId, ...(current.sourceItemId ? { sourceItemId: current.sourceItemId } : {}) });
      if (current.sourceItemId) {
        const queue = await repository.getQueue(current.sessionId);
        const item = queue.items.find((candidate) => candidate.itemId === current.sourceItemId);
        if (item) queueUpdated(sink, current.sessionId, item, queue.sessionRevision);
        sink({ type: 'user_message_committed', sessionId: current.sessionId, runId: current.runId, itemId: current.sourceItemId });
      }
      const onEvent = observedSink(handle);
      let summary: TaskSummary;
      try {
        summary = await environment.agent.runTask(
          current.sessionId,
          current.prompt,
          null,
          onEvent,
          runHooks(handle, onEvent),
          {
            runId: current.runId,
            signal: handle.abortController.signal,
            prestarted: current.prestarted,
            ...(current.isNew !== undefined ? { isNew: current.isNew } : {}),
            ...(current.clientRequestId ? { clientRequestId: current.clientRequestId } : {}),
            ...(current.sourceItemId ? { sourceItemId: current.sourceItemId } : {}),
            ...(current.notificationDelivery ? { origin: 'orchestrated' as const, budget: AGENT_NOTIFICATION_BUDGET } : {}),
            commandSource: commandSource(handle),
            ...(dependencies.createLifecycleHooks ? {
              lifecycle: dependencies.createLifecycleHooks(current.sessionId, current.runId),
            } : {}),
            beforeFinish: async ({ status }) => {
              if (status !== 'completed' && !handle.stoppedFor) await requeueAndPause(handle, 'failure', status);
            },
            ...(stream.onRunEvent ? {
              onRunEvent: stream.onRunEvent,
              legacyEvents: stream.legacyEvents ?? false,
              presentationHooks: (emit) => runHooks(handle, onEvent, emit),
            } : {}),
          },
        );
      } finally {
        await withSessionLock(current.sessionId, async () => unregister(handle));
      }
      summaries.push(summary!);
      if (handle.stoppedFor || chain.stoppedFor) {
        if (!handle.stoppedFor) await requeueAndPause(handle, chain.stoppedFor!, summary!.status);
        observe({ metric: 'run_chain.length', value: summaries.length, sessionId: current.sessionId, runId: current.runId, outcome: 'paused' });
        return { summaries, paused: true };
      }
      if (summary!.status !== 'completed') {
        observe({ metric: 'run_chain.length', value: summaries.length, sessionId: current.sessionId, runId: current.runId, outcome: summary!.status });
        return { summaries, paused: true };
      }
      const nextRunId = crypto.randomUUID();
      const claimed = await repository.beginRunFromQueue({
        sessionId: current.sessionId,
        runId: nextRunId,
        context: environment.context,
        operationId: `drain:${current.runId}:${nextRunId}`,
      });
      if (!claimed) {
        const notificationRun = await beginAgentNotificationRun(current.sessionId, environment.context);
        if (notificationRun) {
          current = { sessionId: current.sessionId, runId: notificationRun.runId, prompt: notificationRun.prompt, prestarted: true, notificationDelivery: true };
          continue;
        }
        observe({ metric: 'run_chain.length', value: summaries.length, sessionId: current.sessionId, runId: current.runId, outcome: 'completed' });
        return { summaries, paused: false };
      }
      observe({ metric: 'queue.wait_ms', value: Math.max(0, Date.now() - Date.parse(claimed.item.createdAt)), sessionId: current.sessionId, runId: nextRunId, itemId: claimed.item.itemId, delivery: 'next_run' });
      current = { sessionId: current.sessionId, runId: nextRunId, prompt: claimed.message.content, prestarted: true, sourceItemId: claimed.item.itemId };
    }
  }

  async function start(input: StartConversationRunInput, sink: EventSink, stream: CoordinatorStreamOptions = {}): Promise<RunChainResult> {
    const chain: ConversationRunChain = { chainId: crypto.randomUUID(), sessionId: input.sessionId, sink };
    await withSessionLock(input.sessionId, async () => {
      if (chainsBySessionId.has(input.sessionId)) throw new Error('Session already has an active Run chain');
      chainsBySessionId.set(input.sessionId, chain);
    });
    try {
      await repository.setQueuePaused({ sessionId: input.sessionId, paused: false, operationId: `start:${input.runId}:resume` });
      return await executeChain(input, sink, chain, stream);
    } finally {
      await unregisterChain(chain);
    }
  }

  async function resume(sessionId: string, sink: EventSink, stream: CoordinatorStreamOptions = {}): Promise<RunChainResult> {
    const chain: ConversationRunChain = { chainId: crypto.randomUUID(), sessionId, sink };
    let next: { runId: string; prompt: string; sourceItemId?: string; notificationDelivery?: true } | null;
    try {
      next = await withSessionLock(sessionId, async () => {
        if (chainsBySessionId.has(sessionId) || activeBySessionId.has(sessionId)) throw new Error('Session already has an active Run');
        chainsBySessionId.set(sessionId, chain);
        const session = await repository.loadSession(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        const environment = await dependencies.resolveEnvironment(session);
        const runId = crypto.randomUUID();
        const claimed = await repository.beginRunFromQueue({ sessionId, runId, context: environment.context, operationId: `resume:${runId}` });
        if (!claimed) return beginAgentNotificationRun(sessionId, environment.context);
        queueUpdated(sink, sessionId, claimed.item, claimed.session.revision ?? 0);
        return { runId, prompt: claimed.message.content, sourceItemId: claimed.item.itemId };
      });
    } catch (error) {
      await unregisterChain(chain);
      throw error;
    }
    if (!next) {
      await unregisterChain(chain);
      return { summaries: [], paused: false };
    }
    try {
      return await executeChain({ sessionId, runId: next.runId, prompt: next.prompt, prestarted: true, ...(next.sourceItemId ? { sourceItemId: next.sourceItemId } : {}), ...(next.notificationDelivery ? { notificationDelivery: true } : {}) }, sink, chain, stream);
    } finally {
      await unregisterChain(chain);
    }
  }

  async function submitDuringRun(input: SubmitDuringRunInput): Promise<QueueMutationOutcome> {
    return withSessionLock(input.sessionId, async () => {
      const handle = activeBySessionId.get(input.sessionId);
      const steerTarget = input.delivery === 'steer' ? acceptingSteerTarget(handle, input.expectedRunId) : undefined;
      const queued = await repository.enqueueQueueItem({
        sessionId: input.sessionId,
        content: input.content,
        delivery: steerTarget ? 'steer' : 'next_run',
        operationId: input.operationId,
        ...(steerTarget ? { targetRunId: steerTarget.runId } : {}),
        ...(input.expectedSessionRevision !== undefined ? { expectedSessionRevision: input.expectedSessionRevision } : {}),
      });
      observe({ metric: 'queue.enqueue.count', value: 1, sessionId: input.sessionId, runId: handle?.runId, itemId: queued.item.itemId, operationId: input.operationId, delivery: queued.item.delivery, outcome: steerTarget ? 'steered' : 'queued' });
      if (queued.replayed) observe({ metric: 'queue.idempotent_replay.count', value: 1, sessionId: input.sessionId, runId: handle?.runId, itemId: queued.item.itemId, operationId: input.operationId });
      observe({ metric: 'queue.pending.count', value: (await repository.getQueue(input.sessionId)).pending.length, sessionId: input.sessionId, runId: handle?.runId });
      handle?.sink({ type: 'queue_item_added', sessionId: input.sessionId, item: queued.item, sessionRevision: queued.sessionRevision });
      if (input.delivery !== 'steer' || steerTarget) {
        return steerTarget
          ? { outcome: 'steered', item: queued.item, targetRunId: steerTarget.runId, sessionRevision: queued.sessionRevision }
          : queued;
      }
      const reason = handle ? 'run_closing' : 'run_changed';
      return { outcome: 'remained_queued', item: queued.item, reason, sessionRevision: queued.sessionRevision };
    });
  }

  async function mutateQueue(command: QueueCommand) {
    return withSessionLock(command.sessionId, async () => {
      const handle = activeBySessionId.get(command.sessionId);
      if (command.type === 'promote_to_steer') {
        const steerTarget = acceptingSteerTarget(handle, command.expectedRunId);
        if (!steerTarget) {
          const queue = await repository.getQueue(command.sessionId);
          const item = queue.items.find((candidate) => candidate.itemId === command.itemId);
          if (!item) throw new Error(`Queue item not found: ${command.itemId}`);
          if (item.status === 'consumed') return { outcome: 'already_consumed', itemId: item.itemId, runId: item.consumedRunId!, sessionRevision: queue.sessionRevision } as const;
          const reason = handle ? 'run_closing' : 'run_changed';
          observe({ metric: 'queue.promote.count', value: 1, sessionId: command.sessionId, runId: handle?.runId, itemId: command.itemId, operationId: command.operationId, outcome: `remained_queued:${reason}` });
          return { outcome: 'remained_queued', item, reason, sessionRevision: queue.sessionRevision } as const;
        }
        const result = await repository.promoteQueueItem(command);
        observe({ metric: 'queue.promote.count', value: 1, sessionId: command.sessionId, runId: steerTarget.runId, itemId: command.itemId, operationId: command.operationId, outcome: result.outcome });
        if ('replayed' in result && result.replayed) observe({ metric: 'queue.idempotent_replay.count', value: 1, sessionId: command.sessionId, runId: steerTarget.runId, itemId: command.itemId, operationId: command.operationId });
        if (result.outcome === 'steered') queueUpdated(steerTarget.sink, command.sessionId, result.item, result.sessionRevision);
        return result;
      }
      if (command.type === 'cancel') {
        const result = await repository.cancelQueueItem(command);
        observe({ metric: 'queue.cancel.count', value: 1, sessionId: command.sessionId, runId: handle?.runId, itemId: command.itemId, operationId: command.operationId, outcome: result.outcome });
        if (result.outcome === 'cancelled') handle?.sink({ type: 'queue_item_removed', sessionId: command.sessionId, itemId: command.itemId, reason: 'user_deleted', sessionRevision: result.sessionRevision });
        return result;
      }
      const result = await repository.reorderQueueItems(command);
      handle?.sink({ type: 'queue_reordered', sessionId: command.sessionId, orderedItemIds: result.orderedItemIds, sessionRevision: result.sessionRevision });
      return result;
    });
  }

  async function stop(input: { runId?: string; sessionId?: string; reason?: QueuePauseReason }) {
    const handle = input.runId ? activeByRunId.get(input.runId) : input.sessionId ? activeBySessionId.get(input.sessionId) : undefined;
    const sessionId = handle?.sessionId ?? input.sessionId;
    const chain = sessionId ? chainsBySessionId.get(sessionId) : undefined;
    if (!handle && !chain) return { stopped: false };
    const reason = input.reason ?? 'user_stop';
    if (chain) chain.stoppedFor = reason;
    if (!handle) {
      const queue = await repository.getQueue(sessionId!);
      if (queue.pending.length > 0) {
        await repository.setQueuePaused({ sessionId: sessionId!, paused: true, reason, operationId: `chain:${chain!.chainId}:pause:${reason}` });
        chain?.sink({ type: 'run_chain_paused', sessionId: sessionId!, reason });
      }
      return { stopped: true, sessionId };
    }
    await withSessionLock(handle.sessionId, async () => {
      if (handle.phase === 'terminal') return;
      handle.phase = 'stopping';
      handle.stoppedFor = reason;
      dependencies.cancelPending?.(handle.sessionId, handle.runId, handle.stoppedFor);
      handle.abortController.abort(reason);
      await requeueAndPause(handle, handle.stoppedFor);
    });
    return { stopped: true, sessionId: handle.sessionId };
  }

  async function snapshot(sessionId: string): Promise<ConversationRuntimeSnapshot> {
    const queue = await repository.getQueue(sessionId);
    const handle = activeBySessionId.get(sessionId);
    return {
      ...(handle ? { activeRun: { runId: handle.runId, phase: handle.phase } } : {}),
      queuedItems: queue.pending,
      queuePaused: queue.paused,
      sessionRevision: queue.sessionRevision,
    };
  }

  return { start, resume, submitDuringRun, mutateQueue, stop, snapshot };
}
