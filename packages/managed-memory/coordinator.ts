import { readFile, rename, writeFile } from 'node:fs/promises';
import type { ContextSection } from '../context-engine/index.ts';
import type { ChatMessage, ToolResultMessage } from '../shared/types.ts';
import { debugLog } from '../shared/debug.ts';
import {
  DEFAULT_MANAGED_MEMORY_SETTINGS,
  type ClearManagedMemoryInput,
  type EnqueueMemoryExtractionInput,
  type InternalMemoryRunner,
  type ManagedMemoryDrainResult,
  type ManagedMemoryMode,
  type ManagedMemorySettingsPatch,
  type ManagedMemorySnapshot,
  type MemorySelector,
  type PrepareManagedMemoryInput,
  type PreparedManagedMemory,
} from './contracts.ts';
import { buildConsolidationPrompt, buildExtractionPrompt } from './prompt.ts';
import { createMemoryRecall } from './recall.ts';
import type { ManagedMemoryStore } from './store.ts';
import { MEMORY_AGENT_TOOL_POLICY, createManagedMemoryToolExecutor, type ManagedMemoryToolContext } from './tools.ts';

type ExtractionProgress = { messageId?: string; eligibleRuns: number; lastEnqueuedRunId?: string; retry: boolean };
type PendingExtraction = { input: EnqueueMemoryExtractionInput; completedRuns: number; trailing: boolean };
type ConsolidationState = {
  version: 1;
  lastCompletedAt?: string;
  completedSessionIds: string[];
  lastScanAt?: string;
  lastError?: string;
  lock?: { holderId: string; pid: number; acquiredAt: string };
};

type CoordinatorOptions = {
  workspaceId: string;
  mode: ManagedMemoryMode;
  store: ManagedMemoryStore;
  selector: MemorySelector;
  now?: () => Date;
  observe?: (event: Record<string, unknown>) => void;
};

const GLOBAL_MEMORY_RUN_LIMIT = 2;
let globalMemoryRuns = 0;
const globalMemoryWaiters: Array<() => void> = [];

async function acquireGlobalMemorySlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (globalMemoryRuns >= GLOBAL_MEMORY_RUN_LIMIT) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const index = globalMemoryWaiters.indexOf(ready);
        if (index >= 0) globalMemoryWaiters.splice(index, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      globalMemoryWaiters.push(ready);
      signal?.addEventListener('abort', abort, { once: true });
    });
  } else globalMemoryRuns += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = globalMemoryWaiters.shift();
    if (next) next(); // Transfer the reservation without opening a slot to a new arrival.
    else globalMemoryRuns -= 1;
  };
}

async function runWithGlobalMemorySlot<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  const release = await acquireGlobalMemorySlot(signal);
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return await action();
  } finally { release(); }
}

function directMutation(input: EnqueueMemoryExtractionInput): boolean {
  return input.toolCalls.some((call) => {
    if (call.name !== 'memory_upsert' && call.name !== 'memory_remove') return false;
    const value = call.outcome;
    if (value && typeof value === 'object' && !Array.isArray(value)) return (value as { mutationCommitted?: unknown }).mutationCommitted === true;
    if (typeof value !== 'string') return false;
    try { return (JSON.parse(value) as { mutationCommitted?: unknown }).mutationCommitted === true; } catch { return false; }
  });
}

function successfulMemoryMutations(messages: ChatMessage[]): number {
  return messages.filter((message): message is ToolResultMessage => message.role === 'tool' && (message.name === 'memory_upsert' || message.name === 'memory_remove'))
    .filter((message) => { try { return (JSON.parse(message.content) as { mutationCommitted?: unknown }).mutationCommitted === true; } catch { return false; } })
    .length;
}

function hasUnresolvedMemoryMutation(messages: ChatMessage[]): boolean {
  const targets = new Map<string, string>();
  const unresolved = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        try {
          const args = JSON.parse(call.function.arguments) as { path?: unknown };
          if (typeof args.path === 'string') targets.set(call.id, `${call.function.name}:${args.path}`);
        } catch { /* Malformed calls remain unresolved unless their target can be identified. */ }
      }
    }
    if (message.role !== 'tool' || (message.name !== 'memory_upsert' && message.name !== 'memory_remove')) continue;
    let key = targets.get(message.tool_call_id) ?? `${message.name}:call:${message.tool_call_id}`;
    try {
      const outcome = JSON.parse(message.content) as { mutationCommitted?: unknown; path?: unknown };
      if (typeof outcome.path === 'string') key = `${message.name}:${outcome.path}`;
      if (outcome.mutationCommitted === true) unresolved.delete(key);
      else unresolved.add(key);
    } catch { unresolved.add(key); }
  }
  return unresolved.size > 0;
}

export function parseManagedMemoryMode(environment: Record<string, string | undefined> = process.env): ManagedMemoryMode {
  const value = environment.DEXCODE_MANAGED_MEMORY_MODE?.trim().toLowerCase();
  if (!value) return 'on';
  if (value === 'off' || value === 'observe' || value === 'on') return value;
  throw new Error('DEXCODE_MANAGED_MEMORY_MODE must be off, observe, or on');
}

export function createManagedMemoryCoordinator(options: CoordinatorOptions) {
  const now = options.now ?? (() => new Date());
  const recall = createMemoryRecall({ workspaceId: options.workspaceId, store: options.store, selector: options.selector, now: () => now().getTime(), observe: (value) => metric('managed_memory.recall.completed', value) });
  const executeTool = createManagedMemoryToolExecutor(options.store);
  const pendingBySession = new Map<string, PendingExtraction>();
  const progressBySession = new Map<string, ExtractionProgress>();
  let extractingSessionId: string | undefined;
  let extractionController: AbortController | undefined;
  let configurationRevision = 0;
  const activeControllers = new Set<AbortController>();
  let runner: InternalMemoryRunner | undefined;
  let worker: Promise<void> | undefined;
  let pendingConsolidation = false;
  let accepting = true;
  let lastExtractionAt: string | undefined;
  let lastConsolidationAt: string | undefined;
  let lastError: string | undefined;

  const metric = (name: string, fields: Record<string, unknown> = {}) => {
    try { options.observe?.({ type: name, workspaceId: options.workspaceId, ...fields }); } catch { /* Diagnostics must not affect either Run. */ }
  };

  async function atomicJson(path: string, value: unknown) {
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(temp, path);
  }

  async function loadConsolidation(): Promise<ConsolidationState> {
    try {
      const parsed = JSON.parse(await readFile(options.store.paths.consolidation, 'utf8')) as ConsolidationState;
      return parsed?.version === 1 ? parsed : { version: 1, completedSessionIds: [] };
    } catch { return { version: 1, completedSessionIds: [] }; }
  }

  async function noteCompletedSession(sessionId: string) {
    const state = await loadConsolidation();
    state.completedSessionIds = [...new Set([...state.completedSessionIds, sessionId])];
    await atomicJson(options.store.paths.consolidation, state);
  }

  async function runExtraction(pending: PendingExtraction): Promise<void> {
    const { input } = pending;
    const progress = progressBySession.get(input.sessionId)!;
    const controller = new AbortController();
    extractionController = controller;
    activeControllers.add(controller);
    const started = Date.now();
    let usage: unknown;
    try {
      const settings = await options.store.settings();
      if (controller.signal.aborted || options.mode !== 'on' || !settings.enabled || !settings.extractionEnabled || !runner) return;
      const endId = input.messageIds.at(-1);
      if (!endId || input.messages.length !== input.messageIds.length) throw new Error('Memory extraction snapshot lacks stable message identities');
      const advance = () => { progress.messageId = endId; progress.retry = false; };
      if (directMutation(input)) {
        await noteCompletedSession(input.sessionId);
        if (controller.signal.aborted) return;
        advance();
        progress.eligibleRuns = 0;
        metric('managed_memory.extraction.skipped_direct_write', { runId: input.runId, sessionId: input.sessionId });
        return;
      }
      progress.eligibleRuns += pending.completedRuns;
      if (!pending.trailing && !progress.retry && progress.eligibleRuns < settings.extractionEveryCompletedRuns) return;
      progress.eligibleRuns = 0;
      const cursorIndex = progress.messageId ? input.messageIds.indexOf(progress.messageId) : -1;
      const start = cursorIndex + 1;
      if (start === input.messages.length) return;
      const newMessageCount = input.messages.slice(start).filter((message) => message.role !== 'system').length;
      extractingSessionId = input.sessionId;
      const manifest = await options.store.scan(options.workspaceId, controller.signal);
      metric('managed_memory.extraction.started', { runId: input.runId, sessionId: input.sessionId, model: input.modelClient.model, newMessageCount });
      const result = await runWithGlobalMemorySlot(controller.signal, () => runner!.run({
        kind: 'extraction', parentRunId: input.runId, sessionId: input.sessionId, generation: settings.generation,
        modelClient: input.modelClient,
        messages: [...input.messages, { role: 'user', content: buildExtractionPrompt({
          manifest,
          checkpointDescription: `只提取上述对话最后 ${newMessageCount} 条非 system 消息中的新信息。${cursorIndex < 0 ? '尚无游标或游标已离开压缩后的上下文，分析当前可见历史。' : '更早的前缀仅供理解，已经处理过。'}`,
          completedAt: input.completedAt,
        }) }],
        systemSections: input.systemSections,
        signal: controller.signal,
      }));
      usage = result.usage;
      if (controller.signal.aborted) return;
      if (result.status !== 'completed') throw new Error(result.error?.message ?? `memory agent ended ${result.status}`);
      if (hasUnresolvedMemoryMutation(result.messages)) throw new Error('Memory Agent left a mutation conflict or write failure unresolved');
      await noteCompletedSession(input.sessionId);
      if (controller.signal.aborted) return;
      advance();
      lastError = undefined;
      lastExtractionAt = now().toISOString();
      metric('managed_memory.extraction.completed', { runId: input.runId, sessionId: input.sessionId, memoriesSaved: successfulMemoryMutations(result.messages), durationMs: Date.now() - started, usage });
    } catch (error) {
      if (!controller.signal.aborted) {
        progress.retry = true;
        lastError = 'Memory extraction failed; will reconsider on the next completed Run';
        metric('managed_memory.extraction.failed', { runId: input.runId, sessionId: input.sessionId, durationMs: Date.now() - started, usage });
        debugLog('managed_memory.extraction.error', error);
      }
    } finally {
      if (controller.signal.aborted) metric('managed_memory.extraction.cancelled', { runId: input.runId, sessionId: input.sessionId, durationMs: Date.now() - started, usage });
      extractingSessionId = undefined;
      extractionController = undefined;
      activeControllers.delete(controller);
    }
  }

  async function shouldAutoConsolidate(): Promise<boolean> {
    const settings = await options.store.settings();
    if (!settings.enabled || !settings.consolidationEnabled) return false;
    const state = await loadConsolidation();
    const last = state.lastCompletedAt ? Date.parse(state.lastCompletedAt) : 0;
    if (now().getTime() - last < settings.consolidationMinHours * 3_600_000) return false;
    const lastScan = state.lastScanAt ? Date.parse(state.lastScanAt) : 0;
    if (now().getTime() - lastScan < 10 * 60_000) return false;
    state.lastScanAt = now().toISOString();
    await atomicJson(options.store.paths.consolidation, state);
    return state.completedSessionIds.length >= settings.consolidationMinSessions;
  }

  async function runConsolidation(force = false): Promise<{ started: boolean; reason?: string }> {
    if (!runner || options.mode !== 'on') return { started: false, reason: 'unavailable' };
    const settings = await options.store.settings();
    if (!settings.enabled) return { started: false, reason: 'disabled' };
    if (!force && !(await shouldAutoConsolidate())) return { started: false, reason: 'gate_closed' };
    const state = await loadConsolidation();
    const acquiredAt = now().toISOString();
    const existingAge = state.lock ? now().getTime() - Date.parse(state.lock.acquiredAt) : Number.POSITIVE_INFINITY;
    if (state.lock && existingAge < 3_600_000) return { started: false, reason: 'locked' };
    const priorCompletedAt = state.lastCompletedAt;
    const holderId = crypto.randomUUID();
    state.lock = { holderId, pid: process.pid, acquiredAt };
    await atomicJson(options.store.paths.consolidation, state);
    const controller = new AbortController();
    activeControllers.add(controller);
    try {
      const [index, manifest] = await Promise.all([options.store.readIndex(options.workspaceId), options.store.scan(options.workspaceId)]);
      const result = await runWithGlobalMemorySlot(controller.signal, () => runner!.run({
        kind: 'consolidation', generation: settings.generation, messages: [],
        systemSections: [{ source: 'systemPrompt', content: buildConsolidationPrompt({ manifest, index: index?.raw ?? '', sessionIds: state.completedSessionIds }) }],
        signal: controller.signal,
      }));
      if (result.status !== 'completed') throw new Error(result.error?.message ?? `consolidator ended ${result.status}`);
      state.lastCompletedAt = now().toISOString();
      state.completedSessionIds = [];
      delete state.lastError;
      delete state.lock;
      await atomicJson(options.store.paths.consolidation, state);
      lastConsolidationAt = state.lastCompletedAt;
      metric('managed_memory.consolidation.completed', { topicCount: manifest.length });
      return { started: true };
    } catch (error) {
      state.lastCompletedAt = priorCompletedAt;
      state.lastError = error instanceof Error ? error.message : String(error);
      delete state.lock;
      await atomicJson(options.store.paths.consolidation, state);
      lastError = state.lastError;
      return { started: true, reason: 'failed' };
    } finally {
      activeControllers.delete(controller);
    }
  }

  async function workLoop() {
    while (pendingBySession.size > 0 || pendingConsolidation) {
      const next = pendingBySession.entries().next().value;
      if (next) {
        pendingBySession.delete(next[0]);
        await runExtraction(next[1]);
        try { if (await shouldAutoConsolidate()) await runConsolidation(true); } catch (error) { debugLog('managed_memory.consolidation.error', error); }
      } else if (pendingConsolidation) {
        pendingConsolidation = false;
        await runConsolidation(true);
      }
    }
  }

  function startWorker() {
    if (worker) return;
    worker = workLoop().catch((error: unknown) => {
      metric('managed_memory.worker.failed');
      debugLog('managed_memory.worker.error', error);
    }).finally(() => {
      worker = undefined;
      if (accepting && pendingBySession.size > 0) startWorker();
    });
  }

  async function prepareRun(input: PrepareManagedMemoryInput): Promise<PreparedManagedMemory> {
    const revision = configurationRevision;
    if (input.workspaceId !== options.workspaceId || options.mode === 'off') {
      return { enabled: false, generation: 0, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0 } };
    }
    try {
      const settings = await options.store.settings();
      if (!settings.enabled) return { enabled: false, generation: settings.generation, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0 } };
      const prepared = await recall.prepare({
        sessionId: input.sessionId, runId: input.runId, query: input.query, generation: settings.generation,
        ...(input.contextOwnerId ? { contextOwnerId: input.contextOwnerId } : {}),
        inject: options.mode === 'on', recallEnabled: settings.recallEnabled, signal: input.signal,
      });
      if (revision !== configurationRevision) {
        prepared.prefetch?.dispose();
        return { ...prepared, enabled: false, sections: [], refs: [], prefetch: undefined };
      }
      metric('managed_memory.recall.prepared', { candidateCount: prepared.recall.candidateCount, durationMs: prepared.recall.durationMs });
      return options.mode === 'observe' ? { ...prepared, enabled: false, sections: [], refs: [] } : prepared;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      lastError = 'Memory recall preparation failed';
      debugLog('managed_memory.recall.error', error);
      metric('managed_memory.recall.failed');
      return { enabled: false, generation: 0, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0, warning: lastError } };
    }
  }

  function enqueueExtraction(input: EnqueueMemoryExtractionInput) {
    if (!accepting || options.mode !== 'on' || input.workspaceId !== options.workspaceId || input.status !== 'completed') return;
    const progress = progressBySession.get(input.sessionId) ?? { eligibleRuns: 0, retry: false };
    if (progress.lastEnqueuedRunId === input.runId) return;
    progress.lastEnqueuedRunId = input.runId;
    progressBySession.set(input.sessionId, progress);
    const previous = pendingBySession.get(input.sessionId);
    const coalesced = Boolean(previous);
    const { modelClient, ...snapshot } = input;
    pendingBySession.set(input.sessionId, { input: { ...structuredClone(snapshot), modelClient }, completedRuns: (previous?.completedRuns ?? 0) + 1, trailing: previous?.trailing === true || extractingSessionId === input.sessionId });
    metric(coalesced ? 'managed_memory.extraction.coalesced' : 'managed_memory.extraction.enqueued', { runId: input.runId });
    startWorker();
  }

  async function requestConsolidation(): Promise<{ started: boolean; reason?: string }> {
    const settings = await options.store.settings();
    if (!accepting || !runner || options.mode !== 'on') return { started: false, reason: 'unavailable' };
    if (!settings.enabled) return { started: false, reason: 'disabled' };
    if (pendingConsolidation) return { started: false, reason: 'coalesced' };
    pendingConsolidation = true;
    startWorker();
    return { started: true };
  }

  async function drain(input: { timeoutMs?: number } = {}): Promise<ManagedMemoryDrainResult> {
    accepting = false;
    recall.cancelAll();
    const timeoutMs = input.timeoutMs ?? 60_000;
    let timedOut = false;
    if (worker) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([worker, new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]);
      if (timer) clearTimeout(timer);
    }
    let aborted = 0;
    if (timedOut) for (const controller of activeControllers) { controller.abort(); aborted += 1; }
    const pending = pendingBySession.size;
    if (timedOut) { pendingBySession.clear(); pendingConsolidation = false; }
    return { completed: !timedOut, aborted, pending };
  }

  async function inspect(workspaceId: string): Promise<ManagedMemorySnapshot> {
    if (workspaceId !== options.workspaceId) throw new Error('Workspace binding mismatch');
    const [settings, headers, index] = await Promise.all([options.store.settings(), options.store.scan(workspaceId), options.store.readIndex(workspaceId)]);
    const diagnostic = options.store.diagnostics();
    return {
      workspaceId, mode: options.mode, settings, topicCount: headers.length, indexExists: Boolean(index),
      totalBytes: headers.reduce((sum, item) => sum + item.bytes, index?.bytes ?? 0), degraded: diagnostic.degraded, diagnostics: diagnostic.messages,
      background: { inProgress: Boolean(worker), pendingSessions: pendingBySession.size, ...(lastExtractionAt ? { lastExtractionAt } : {}), ...(lastConsolidationAt ? { lastConsolidationAt } : {}), ...(lastError ? { lastError } : {}) },
    };
  }

  async function updateSettings(workspaceId: string, patch: ManagedMemorySettingsPatch) {
    if (options.mode === 'off') return { ...DEFAULT_MANAGED_MEMORY_SETTINGS, enabled: false };
    const settings = await options.store.updateSettings(workspaceId, patch);
    configurationRevision += 1;
    if (!settings.enabled || !settings.recallEnabled) recall.cancelAll();
    if (!settings.enabled) {
      pendingBySession.clear();
      for (const controller of activeControllers) controller.abort();
    } else accepting = true;
    if (!settings.extractionEnabled) { pendingBySession.clear(); extractionController?.abort(); }
    return settings;
  }

  async function clearManagedMemory(workspaceId: string, input: ClearManagedMemoryInput) {
    if (input.confirmationToken !== 'CLEAR_MANAGED_MEMORY') throw new Error('Managed memory clear confirmation token is invalid');
    configurationRevision += 1;
    pendingBySession.clear();
    progressBySession.clear();
    pendingConsolidation = false;
    for (const controller of activeControllers) controller.abort();
    if (worker) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([worker, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
      if (timer) clearTimeout(timer);
    }
    recall.clearAll();
    accepting = true;
    return options.store.clear(workspaceId);
  }

  return {
    prepareRun,
    enqueueExtraction,
    drain,
    inspect,
    updateSettings,
    clearManagedMemory,
    async executeTool(name: string, args: Record<string, unknown>, context: ManagedMemoryToolContext) {
      if (options.mode !== 'on') return { error: 'Managed memory writes are disabled by runtime mode', code: 'MEMORY_DISABLED' };
      return executeTool(name, args, context);
    },
    setInternalRunner(value: InternalMemoryRunner) { runner = value; },
    async rebuildIndex(workspaceId: string) { return options.store.rebuildIndex(workspaceId); },
    consolidate: requestConsolidation,
    toolPolicy: MEMORY_AGENT_TOOL_POLICY,
    mode: options.mode,
    workspaceId: options.workspaceId,
  };
}

export type ManagedMemoryCoordinator = ReturnType<typeof createManagedMemoryCoordinator>;
