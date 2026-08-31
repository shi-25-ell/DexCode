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

export function createConversationRunCoordinator(dependencies: {
  repository: SessionRepository;
  resolveEnvironment(session: Session): Promise<RunEnvironment>;
  createHooks(sessionId: string, runId: string, sink: EventSink): ExecutorHooks;
}) {
  const { repository } = dependencies;
  const activeByRunId = new Map<string, ActiveConversationRun>();
  const activeBySessionId = new Map<string, ActiveConversationRun>();
  const locks = new Map<string, Promise<void>>();

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
    const queue = await repository.getQueue(handle.sessionId);
    if (queue.pending.length > 0) {
      await repository.setQueuePaused({ sessionId: handle.sessionId, paused: true, reason, operationId: `terminal:${handle.runId}:pause:${reason}` });
      handle.sink({ type: 'run_chain_paused', sessionId: handle.sessionId, reason });
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
            for (const item of requeued.items) queueUpdated(handle.sink, handle.sessionId, item, requeued.sessionRevision);
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
      if (event.type === 'task_status' && event.taskId === handle.runId) {
        if (event.status === 'waiting_confirm' && handle.phase === 'accepting_commands') handle.phase = 'waiting_confirm';
        else if (event.status === 'executing' && handle.phase === 'waiting_confirm') handle.phase = 'accepting_commands';
      }
      handle.sink(event);
    };
  }

  async function executeChain(first: StartConversationRunInput, sink: EventSink): Promise<RunChainResult> {
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
          dependencies.createHooks(current.sessionId, current.runId, onEvent),
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
      if (handle.stoppedFor) return { summaries, paused: true };
      if (summary!.status !== 'completed') {
        await requeueAndPause(handle, 'failure', summary!.status);
        return { summaries, paused: true };
      }
      const nextRunId = crypto.randomUUID();
      const claimed = await repository.beginRunFromQueue({
        sessionId: current.sessionId,
        runId: nextRunId,
        context: environment.context,
        operationId: `drain:${current.runId}:${nextRunId}`,
      });
      if (!claimed) return { summaries, paused: false };
      queueUpdated(sink, current.sessionId, claimed.item, claimed.session.revision ?? 0);
      sink({ type: 'user_message_committed', sessionId: current.sessionId, runId: nextRunId, itemId: claimed.item.itemId });
      current = { sessionId: current.sessionId, runId: nextRunId, prompt: claimed.message.content, prestarted: true, sourceItemId: claimed.item.itemId };
    }
  }

  async function start(input: StartConversationRunInput, sink: EventSink): Promise<RunChainResult> {
    await repository.setQueuePaused({ sessionId: input.sessionId, paused: false, operationId: `start:${input.runId}:resume` });
    return executeChain(input, sink);
  }

  async function resume(sessionId: string, sink: EventSink): Promise<RunChainResult> {
    const next = await withSessionLock(sessionId, async () => {
      if (activeBySessionId.has(sessionId)) throw new Error('Session already has an active Run');
      const session = await repository.loadSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const environment = await dependencies.resolveEnvironment(session);
      const runId = crypto.randomUUID();
      const claimed = await repository.beginRunFromQueue({ sessionId, runId, context: environment.context, operationId: `resume:${runId}` });
      if (!claimed) return null;
      queueUpdated(sink, sessionId, claimed.item, claimed.session.revision ?? 0);
      return { runId, prompt: claimed.message.content, sourceItemId: claimed.item.itemId };
    });
    if (!next) return { summaries: [], paused: false };
    return executeChain({ sessionId, runId: next.runId, prompt: next.prompt, prestarted: true, sourceItemId: next.sourceItemId }, sink);
  }

  async function submitDuringRun(input: SubmitDuringRunInput): Promise<QueueMutationOutcome> {
    return withSessionLock(input.sessionId, async () => {
      const handle = activeBySessionId.get(input.sessionId);
      const canSteer = input.delivery === 'steer'
        && handle?.phase === 'accepting_commands'
        && (!input.expectedRunId || input.expectedRunId === handle.runId);
      const queued = await repository.enqueueQueueItem({
        sessionId: input.sessionId,
        content: input.content,
        delivery: canSteer ? 'steer' : 'next_run',
        operationId: input.operationId,
        ...(canSteer ? { targetRunId: handle.runId } : {}),
        ...(input.expectedSessionRevision !== undefined ? { expectedSessionRevision: input.expectedSessionRevision } : {}),
      });
      handle?.sink({ type: 'queue_item_added', sessionId: input.sessionId, item: queued.item, sessionRevision: queued.sessionRevision });
      if (input.delivery !== 'steer' || canSteer) {
        return canSteer
          ? { outcome: 'steered', item: queued.item, targetRunId: handle.runId, sessionRevision: queued.sessionRevision }
          : queued;
      }
      const reason = handle?.phase === 'waiting_confirm' ? 'waiting_confirm' : handle ? 'run_closing' : 'run_changed';
      return { outcome: 'remained_queued', item: queued.item, reason, sessionRevision: queued.sessionRevision };
    });
  }

  async function mutateQueue(command: QueueCommand) {
    return withSessionLock(command.sessionId, async () => {
      const handle = activeBySessionId.get(command.sessionId);
      if (command.type === 'promote_to_steer') {
        if (!handle || handle.runId !== command.expectedRunId || handle.phase !== 'accepting_commands') {
          const queue = await repository.getQueue(command.sessionId);
          const item = queue.items.find((candidate) => candidate.itemId === command.itemId);
          if (!item) throw new Error(`Queue item not found: ${command.itemId}`);
          if (item.status === 'consumed') return { outcome: 'already_consumed', itemId: item.itemId, runId: item.consumedRunId!, sessionRevision: queue.sessionRevision } as const;
          const reason = handle?.phase === 'waiting_confirm' ? 'waiting_confirm' : handle ? 'run_closing' : 'run_changed';
          return { outcome: 'remained_queued', item, reason, sessionRevision: queue.sessionRevision } as const;
        }
        const result = await repository.promoteQueueItem(command);
        if (result.outcome === 'steered') queueUpdated(handle.sink, command.sessionId, result.item, result.sessionRevision);
        return result;
      }
      if (command.type === 'cancel') {
        const result = await repository.cancelQueueItem(command);
        if (result.outcome === 'cancelled') handle?.sink({ type: 'queue_item_removed', sessionId: command.sessionId, itemId: command.itemId, reason: 'user_deleted', sessionRevision: result.sessionRevision });
        return result;
      }
      const result = await repository.reorderQueueItems(command);
      handle?.sink({ type: 'queue_reordered', sessionId: command.sessionId, orderedItemIds: result.orderedItemIds, sessionRevision: result.sessionRevision });
      return result;
    });
  }

  async function stop(input: { runId: string; reason?: QueuePauseReason }) {
    const handle = activeByRunId.get(input.runId);
    if (!handle) return { stopped: false };
    await withSessionLock(handle.sessionId, async () => {
      if (handle.phase === 'terminal') return;
      handle.phase = 'stopping';
      handle.stoppedFor = input.reason ?? 'user_stop';
      handle.abortController.abort(input.reason ?? 'user_stop');
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
