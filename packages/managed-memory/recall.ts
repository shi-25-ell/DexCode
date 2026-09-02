import { collectModelTurn, type ModelClient } from '../llm-client/index.ts';
import type { ContextSection } from '../context-engine/index.ts';
import {
  MANAGED_MEMORY_LIMITS,
  type ManagedMemoryContextRef,
  type MemoryHeader,
  type MemorySelector,
  type PreparedManagedMemory,
} from './contracts.ts';
import { buildMemoryPolicyPrompt, formatManifest } from './prompt.ts';
import { debugLog } from '../shared/debug.ts';
import type { ManagedMemoryStore } from './store.ts';

function ignoreMemory(query: string): boolean {
  return /(?:忽略|不要使用|不使用|别用|不要参考).{0,8}(?:记忆|memory)|(?:ignore|do not use|don't use).{0,8}memor/i.test(query);
}

function words(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((word) => !['the', 'and', 'with', 'this', 'that', '项目', '当前', '一个'].includes(word)));
}

export function lexicalSelect(query: string, candidates: MemoryHeader[], alreadySurfaced: ReadonlySet<string>): string[] {
  const queryWords = words(query);
  return candidates
    .filter((candidate) => !alreadySurfaced.has(`${candidate.path}:${candidate.digest}`))
    .map((candidate) => {
      const candidateWords = words(`${candidate.path} ${candidate.name} ${candidate.description} ${candidate.type}`);
      let score = 0;
      for (const word of queryWords) if (candidateWords.has(word) || [...candidateWords].some((value) => value.includes(word) || word.includes(value))) score += 1;
      return { path: candidate.path, score, mtimeMs: candidate.mtimeMs };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs)
    .slice(0, MANAGED_MEMORY_LIMITS.maxSelectedTopics)
    .map((candidate) => candidate.path);
}

export function createModelMemorySelector(modelClient: ModelClient, timeoutMs = 5_000): MemorySelector {
  return {
    async select(input) {
      const candidates = input.candidates.filter((item) => !input.alreadySurfaced.has(`${item.path}:${item.digest}`));
      if (candidates.length === 0 || input.signal?.aborted) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const forwardAbort = () => controller.abort();
      input.signal?.addEventListener('abort', forwardAbort, { once: true });
      try {
        const response = await collectModelTurn(modelClient.streamMessage([
          { role: 'system', content: 'Select up to five memory filenames that are clearly useful for the query. Return strict JSON only: {"selected":["file.md"]}. Do not invent filenames.' },
          { role: 'user', content: `Query: ${input.query}\n\nAvailable memories:\n${formatManifest(candidates)}` },
        ], { max_tokens: 256, temperature: 0, signal: controller.signal, timeoutMs }));
        if (response.status !== 'completed') throw new Error(response.failure.message);
        const match = /\{[\s\S]*\}/.exec(response.response.content);
        if (!match) throw new Error('selector returned no JSON');
        const parsed = JSON.parse(match[0]) as { selected?: unknown };
        if (!Array.isArray(parsed.selected)) throw new Error('selector selected field is invalid');
        return parsed.selected.filter((value): value is string => typeof value === 'string');
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

export function createMemoryRecall(options: {
  workspaceId: string;
  store: ManagedMemoryStore;
  selector: MemorySelector;
  now?: () => number;
  observe?: (recall: PreparedManagedMemory['recall']) => void;
}) {
  const surfacedBySession = new Map<string, Set<string>>();
  const active = new Map<string, { key: string; promise: Promise<PreparedManagedMemory>; dispose(): void }>();
  const now = options.now ?? Date.now;

  function prepare(input: {
    sessionId: string;
    runId: string;
    contextOwnerId?: string;
    query: string;
    generation: number;
    inject: boolean;
    recallEnabled: boolean;
    signal?: AbortSignal;
  }): Promise<PreparedManagedMemory> {
    const ownerId = input.contextOwnerId ?? input.sessionId;
    const key = JSON.stringify([input.runId, input.query]);
    const existing = active.get(ownerId);
    if (existing?.key === key) return existing.promise;
    existing?.dispose();
    const started = now();
    const controller = new AbortController();
    let ready: ReturnType<NonNullable<PreparedManagedMemory['prefetch']>['takeReady']>;
    let disposed = false;
    const dispose = () => {
      disposed = true;
      ready = undefined;
      controller.abort();
      input.signal?.removeEventListener('abort', dispose);
      if (active.get(ownerId)?.dispose === dispose) active.delete(ownerId);
    };
    input.signal?.addEventListener('abort', dispose, { once: true });
    if (input.signal?.aborted) dispose();
    const promise = Promise.resolve().then(async (): Promise<PreparedManagedMemory> => {
      const empty: PreparedManagedMemory = { enabled: true, generation: input.generation, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0 } };
      if (disposed || ignoreMemory(input.query)) { dispose(); return empty; }
      const [index, allCandidates] = await Promise.all([
        options.store.readIndex(options.workspaceId),
        input.recallEnabled ? options.store.scan(options.workspaceId, controller.signal) : Promise.resolve([]),
      ]);
      if (disposed) return empty;
      const refs: ManagedMemoryContextRef[] = index && input.inject
        ? [{ path: index.path, digest: index.digest, mtimeMs: index.mtimeMs, bytes: index.bytes, truncated: index.truncated, reason: 'index' }]
        : [];
      const sections: ContextSection[] = input.inject ? [
        { source: 'systemPrompt', content: buildMemoryPolicyPrompt(allCandidates.length === 0) },
        { source: 'managedMemory', content: `## Managed Memory Index\n${index?.raw.trim() || '(empty)'}` },
      ] : [];
      const surfaced = surfacedBySession.get(ownerId) ?? new Set<string>();
      const candidates = allCandidates.filter((item) => !surfaced.has(`${item.path}:${item.digest}`));
      const prefetch: NonNullable<PreparedManagedMemory['prefetch']> = {
        takeReady() {
          if (disposed || !ready) return undefined;
          const value = ready;
          if (input.inject) {
            const current = surfacedBySession.get(ownerId) ?? new Set<string>();
            for (const ref of value.refs) current.add(`${ref.path}:${ref.digest}`);
            surfacedBySession.set(ownerId, current);
          }
          dispose();
          return value;
        },
        dispose,
      };
      if (candidates.length > 0) {
        // This promise owns its errors and is never on the main model's critical path.
        void selectTopics(candidates, surfaced).then((value) => {
          if (!disposed) { ready = value; options.observe?.(value.recall); }
        }).catch(() => { if (!disposed) dispose(); });
      }
      return { ...empty, sections, refs, prefetch, recall: { ...empty.recall, candidateCount: candidates.length, durationMs: Math.max(0, now() - started) } };
    }).catch((error: unknown) => { dispose(); throw error; });
    if (!disposed) active.set(ownerId, { key, promise, dispose });
    return promise;

    async function selectTopics(candidates: MemoryHeader[], surfaced: ReadonlySet<string>) {
      let selectedPaths: string[] = [];
      let selector: PreparedManagedMemory['recall']['selector'] = 'none';
      let warning: string | undefined;
      if (input.recallEnabled && candidates.length > 0) {
        try {
          const valid = new Set(candidates.map((candidate) => candidate.path));
          selectedPaths = (await options.selector.select({ query: input.query, candidates, alreadySurfaced: surfaced, signal: controller.signal }))
            .filter((path, indexValue, all) => valid.has(path) && all.indexOf(path) === indexValue)
            .slice(0, MANAGED_MEMORY_LIMITS.maxSelectedTopics);
          selector = 'model';
        } catch (error) {
          if (controller.signal.aborted) throw error;
          debugLog('managed_memory.selector.error', error);
          selectedPaths = lexicalSelect(input.query, candidates, surfaced);
          selector = 'lexical-fallback';
          warning = 'Memory selection failed; used lexical fallback';
        }
      }
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const selected = await Promise.allSettled(selectedPaths.map((path) => options.store.readTopic(options.workspaceId, path, {
        maxLines: MANAGED_MEMORY_LIMITS.maxReadLines,
        maxBytes: MANAGED_MEMORY_LIMITS.maxTopicRecallBytes,
      })));
      const refs: ManagedMemoryContextRef[] = [];
      const topicBlocks: string[] = [];
      for (const item of selected) {
        if (item.status !== 'fulfilled') continue;
        const topic = item.value;
        const ageMs = Math.max(0, now() - topic.mtimeMs);
        const ageDays = Math.floor(ageMs / 86_400_000);
        topicBlocks.push([
          `### ${topic.path} · ${topic.digest.slice(0, 19)} · saved ${ageDays === 0 ? 'today' : `${ageDays}d ago`}`,
          ageMs > 86_400_000 ? '> This memory is older than one day. Verify referenced files, functions, configuration and current state before acting.' : '',
          topic.raw,
          topic.truncated ? '> Topic view truncated; use memory_read for more.' : '',
        ].filter(Boolean).join('\n'));
        refs.push({ path: topic.path, digest: topic.digest, mtimeMs: topic.mtimeMs, bytes: topic.bytes, truncated: topic.truncated, reason: 'relevant' });
      }
      const sections: ContextSection[] = input.inject ? [
        ...(topicBlocks.length > 0 ? [{ source: 'managedMemory' as const, content: `## Relevant Managed Memory\n${topicBlocks.join('\n\n')}` }] : []),
      ] : [];
      return {
        enabled: true,
        generation: input.generation,
        sections,
        refs: input.inject ? refs : [],
        recall: {
          candidateCount: candidates.length,
          selectedCount: topicBlocks.length,
          selector,
          durationMs: Math.max(0, now() - started),
          ...(warning ? { warning } : {}),
        },
      };
    }
  }

  const cancelAll = () => { for (const value of active.values()) value.dispose(); };
  return { prepare, cancelAll, clearSession(sessionId: string) { active.get(sessionId)?.dispose(); surfacedBySession.delete(sessionId); }, clearAll() { cancelAll(); surfacedBySession.clear(); } };
}
