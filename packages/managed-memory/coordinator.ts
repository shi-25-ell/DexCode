import { readFile, rename, writeFile } from 'node:fs/promises';
import type { ContextSection } from '../context-engine/index.ts';
import type { ChatMessage, ToolResultMessage } from '../shared/types.ts';
import {
  DEFAULT_MANAGED_MEMORY_SETTINGS,
  type ClearProjectMemoryInput,
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

type ExtractionCheckpoint = {
  sessionId: string;
  lastProcessedRunId?: string;
  lastProcessedMessageCount: number;
  updatedAt: string;
};

type CheckpointDocument = { version: 1; checkpoints: Record<string, ExtractionCheckpoint> };
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
  }
  globalMemoryRuns += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalMemoryRuns = Math.max(0, globalMemoryRuns - 1);
    globalMemoryWaiters.shift()?.();
  };
}

async function runWithGlobalMemorySlot<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  const release = await acquireGlobalMemorySlot(signal);
  try { return await action(); } finally { release(); }
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
  return messages.some((message) => {
    if (message.role !== 'tool' || (message.name !== 'memory_upsert' && message.name !== 'memory_remove')) return false;
    try {
      const outcome = JSON.parse(message.content) as { mutationCommitted?: unknown; code?: unknown; error?: unknown };
      return outcome.mutationCommitted !== true && Boolean(outcome.code || outcome.error);
    } catch { return true; }
  });
}

export function parseManagedMemoryMode(environment: Record<string, string | undefined> = process.env): ManagedMemoryMode {
  const value = environment.DEXCODE_MANAGED_MEMORY_MODE?.trim().toLowerCase();
  if (!value) return 'on';
  if (value === 'off' || value === 'observe' || value === 'on') return value;
  throw new Error('DEXCODE_MANAGED_MEMORY_MODE must be off, observe, or on');
}

export function createManagedMemoryCoordinator(options: CoordinatorOptions) {
  const now = options.now ?? (() => new Date());
  const recall = createMemoryRecall({ workspaceId: options.workspaceId, store: options.store, selector: options.selector, now: () => now().getTime() });
  const executeTool = createManagedMemoryToolExecutor(options.store);
  const pendingBySession = new Map<string, EnqueueMemoryExtractionInput>();
  const activeControllers = new Set<AbortController>();
  let runner: InternalMemoryRunner | undefined;
  let worker: Promise<void> | undefined;
  let pendingConsolidation = false;
  let accepting = true;
  let lastExtractionAt: string | undefined;
  let lastConsolidationAt: string | undefined;
  let lastError: string | undefined;

  const metric = (name: string, fields: Record<string, unknown> = {}) => options.observe?.({ type: name, workspaceId: options.workspaceId, ...fields });

  async function atomicJson(path: string, value: unknown) {
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(temp, path);
  }

  async function loadCheckpoints(): Promise<CheckpointDocument> {
    try {
      const parsed = JSON.parse(await readFile(options.store.paths.checkpoints, 'utf8')) as CheckpointDocument;
      return parsed?.version === 1 ? parsed : { version: 1, checkpoints: {} };
    } catch { return { version: 1, checkpoints: {} }; }
  }

  async function advanceCheckpoint(input: EnqueueMemoryExtractionInput) {
    const document = await loadCheckpoints();
    document.checkpoints[input.sessionId] = {
      sessionId: input.sessionId,
      lastProcessedRunId: input.runId,
      lastProcessedMessageCount: input.messages.length,
      updatedAt: now().toISOString(),
    };
    await atomicJson(options.store.paths.checkpoints, document);
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

  async function runExtraction(input: EnqueueMemoryExtractionInput): Promise<void> {
    const settings = await options.store.settings();
    if (options.mode !== 'on' || !settings.enabled || !settings.extractionEnabled || !runner || input.status !== 'completed') return;
    if (directMutation(input)) {
      await advanceCheckpoint(input);
      await noteCompletedSession(input.sessionId);
      metric('managed_memory.extraction.skipped_direct_write', { runId: input.runId });
      return;
    }
    const checkpoints = await loadCheckpoints();
    const checkpoint = checkpoints.checkpoints[input.sessionId];
    const start = checkpoint && checkpoint.lastProcessedMessageCount <= input.messages.length ? checkpoint.lastProcessedMessageCount : 0;
    const messages = input.messages.slice(start);
    if (messages.length === 0) {
      await advanceCheckpoint(input);
      return;
    }
    const manifest = await options.store.scan(options.workspaceId);
    const controller = new AbortController();
    activeControllers.add(controller);
    const started = Date.now();
    metric('managed_memory.extraction.started', { runId: input.runId, newMessageCount: messages.length });
    try {
      const result = await runWithGlobalMemorySlot(controller.signal, () => runner!.run({
        kind: 'extraction', parentRunId: input.runId, sessionId: input.sessionId, generation: settings.generation,
        messages,
        systemSections: [{ source: 'systemPrompt', content: buildExtractionPrompt({
          manifest,
          checkpointDescription: checkpoint ? `after run ${checkpoint.lastProcessedRunId ?? 'unknown'}` : 'first extraction for this Session',
          completedAt: input.completedAt,
        }) }],
        signal: controller.signal,
      }));
      if (result.status !== 'completed') throw new Error(result.error?.message ?? `memory agent ended ${result.status}`);
      if (hasUnresolvedMemoryMutation(result.messages)) throw new Error('Memory Agent left a mutation conflict or write failure unresolved');
      await advanceCheckpoint(input);
      await noteCompletedSession(input.sessionId);
      lastExtractionAt = now().toISOString();
      metric('managed_memory.extraction.completed', { runId: input.runId, memoriesSaved: successfulMemoryMutations(result.messages), durationMs: Date.now() - started });
    } catch (error) {
      if (!controller.signal.aborted) {
        lastError = error instanceof Error ? error.message : String(error);
        metric('managed_memory.extraction.failed', { runId: input.runId, durationMs: Date.now() - started });
      }
    } finally {
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
      const next = pendingBySession.entries().next().value as [string, EnqueueMemoryExtractionInput] | undefined;
      if (next) {
        pendingBySession.delete(next[0]);
        await runExtraction(next[1]);
        if (await shouldAutoConsolidate()) await runConsolidation(true);
      } else if (pendingConsolidation) {
        pendingConsolidation = false;
        await runConsolidation(true);
      }
    }
  }

  function startWorker() {
    if (worker) return;
    worker = workLoop().finally(() => {
      worker = undefined;
      if (accepting && pendingBySession.size > 0) startWorker();
    });
  }

  async function prepareRun(input: PrepareManagedMemoryInput): Promise<PreparedManagedMemory> {
    if (input.workspaceId !== options.workspaceId || options.mode === 'off') {
      return { enabled: false, generation: 0, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0 } };
    }
    try {
      const settings = await options.store.settings();
      if (!settings.enabled) return { enabled: false, generation: settings.generation, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0 } };
      const prepared = await recall.prepare({
        sessionId: input.sessionId, query: input.query, generation: settings.generation,
        inject: options.mode === 'on', recallEnabled: settings.recallEnabled, signal: input.signal,
      });
      metric('managed_memory.recall.completed', { candidateCount: prepared.recall.candidateCount, selectedCount: prepared.recall.selectedCount, selector: prepared.recall.selector, durationMs: prepared.recall.durationMs });
      return options.mode === 'observe' ? { ...prepared, enabled: false, sections: [], refs: [] } : prepared;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      metric('managed_memory.recall.failed');
      return { enabled: false, generation: 0, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0, warning: lastError } };
    }
  }

  function enqueueExtraction(input: EnqueueMemoryExtractionInput) {
    if (!accepting || options.mode !== 'on' || input.workspaceId !== options.workspaceId || input.status !== 'completed') return;
    const coalesced = pendingBySession.has(input.sessionId);
    pendingBySession.set(input.sessionId, structuredClone(input));
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
    if (timedOut) pendingBySession.clear();
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
    if (!settings.enabled) {
      pendingBySession.clear();
      for (const controller of activeControllers) controller.abort();
    } else accepting = true;
    return settings;
  }

  async function clearProjectMemory(workspaceId: string, input: ClearProjectMemoryInput) {
    if (input.confirmationToken !== 'CLEAR_MANAGED_MEMORY') throw new Error('Managed memory clear confirmation token is invalid');
    pendingBySession.clear();
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
    clearProjectMemory,
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
