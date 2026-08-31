import type { AgentEvent, QueueDelivery, QueueItemView, QueuePauseReason, RunContext, Session, TaskSummary } from '../shared/types.ts';
import type { ExecutorHooks } from './executor.ts';
import type { QueueMutationOutcome, SessionRepository } from './session-contracts.ts';
import type { RunCommandSource } from './run-commands.ts';

export type ActiveRunPhase = 'accepting_commands' | 'waiting_confirm' | 'closing' | 'stopping' | 'terminal';

type AgentRunner = {
  runTask(
    sessionId: string,
    prompt: string,
    selectedFile: string | null,
    onEvent: (event: AgentEvent) => void,
    hooks: ExecutorHooks,
    options: { runId: string; signal: AbortSignal; prestarted: boolean; clientRequestId?: string; commandSource: RunCommandSource },
  ): Promise<TaskSummary>;
};

type RunEnvironment = { agent: AgentRunner; context: RunContext };
type EventSink = (event: AgentEvent) => void;

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
  clientRequestId?: string;
  sourceItemId?: string;
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
  createHooks(sessionId: string, runId: string, sink: EventSink): ExecutorHooks;
  cancelPending?(sessionId: string, runId: string, reason: QueuePauseReason): void;
  observe?(observation: QueueObservation): void;
}) {
  const { repository } = dependencies;
  const activeByRunId = new Map<string, ActiveConversationRun>();
  const activeBySessionId = new Map<string, ActiveConversationRun>();
  const chainsBySessionId = new Map<string, ConversationRunChain>();
  const locks = new Map<string, Promise<void>>();
  const observe = (observation: QueueObservation) => dependencies.observe?.(observation);

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

  function runHooks(handle: ActiveConversationRun, sink: EventSink): ExecutorHooks {
    const hooks = dependencies.createHooks(handle.sessionId, handle.runId, sink);
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

  async function executeChain(first: StartConversationRunInput, sink: EventSink, chain: ConversationRunChain): Promise<RunChainResult> {
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
            ...(current.clientRequestId ? { clientRequestId: current.clientRequestId } : {}),
            commandSource: commandSource(handle),
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
        await requeueAndPause(handle, 'failure', summary!.status);
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
        observe({ metric: 'run_chain.length', value: summaries.length, sessionId: current.sessionId, runId: current.runId, outcome: 'completed' });
        return { summaries, paused: false };
      }
      queueUpdated(sink, current.sessionId, claimed.item, claimed.session.revision ?? 0);
      observe({ metric: 'queue.wait_ms', value: Math.max(0, Date.now() - Date.parse(claimed.item.createdAt)), sessionId: current.sessionId, runId: nextRunId, itemId: claimed.item.itemId, delivery: 'next_run' });
      sink({ type: 'user_message_committed', sessionId: current.sessionId, runId: nextRunId, itemId: claimed.item.itemId });
      current = { sessionId: current.sessionId, runId: nextRunId, prompt: claimed.message.content, prestarted: true, sourceItemId: claimed.item.itemId };
    }
  }

  async function start(input: StartConversationRunInput, sink: EventSink): Promise<RunChainResult> {
    const chain: ConversationRunChain = { chainId: crypto.randomUUID(), sessionId: input.sessionId, sink };
    await withSessionLock(input.sessionId, async () => {
      if (chainsBySessionId.has(input.sessionId)) throw new Error('Session already has an active Run chain');
      chainsBySessionId.set(input.sessionId, chain);
    });
    try {
      await repository.setQueuePaused({ sessionId: input.sessionId, paused: false, operationId: `start:${input.runId}:resume` });
      return await executeChain(input, sink, chain);
    } finally {
      await unregisterChain(chain);
    }
  }

  async function resume(sessionId: string, sink: EventSink): Promise<RunChainResult> {
    const chain: ConversationRunChain = { chainId: crypto.randomUUID(), sessionId, sink };
    let next: { runId: string; prompt: string; sourceItemId: string } | null;
    try {
      next = await withSessionLock(sessionId, async () => {
        if (chainsBySessionId.has(sessionId) || activeBySessionId.has(sessionId)) throw new Error('Session already has an active Run');
        chainsBySessionId.set(sessionId, chain);
        const session = await repository.loadSession(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        const environment = await dependencies.resolveEnvironment(session);
        const runId = crypto.randomUUID();
        const claimed = await repository.beginRunFromQueue({ sessionId, runId, context: environment.context, operationId: `resume:${runId}` });
        if (!claimed) return null;
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
      return await executeChain({ sessionId, runId: next.runId, prompt: next.prompt, prestarted: true, sourceItemId: next.sourceItemId }, sink, chain);
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
