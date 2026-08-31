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
      if (input.candidates.length === 0) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const forwardAbort = () => controller.abort();
      input.signal?.addEventListener('abort', forwardAbort, { once: true });
      try {
        const response = await collectModelTurn(modelClient.streamMessage([
          { role: 'system', content: 'Select up to five memory filenames that are clearly useful for the query. Return strict JSON only: {"selected":["file.md"]}. Do not invent filenames.' },
          { role: 'user', content: `Query: ${input.query}\n\nAvailable memories:\n${formatManifest(input.candidates.filter((item) => !input.alreadySurfaced.has(`${item.path}:${item.digest}`)))}` },
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
}) {
  const surfacedBySession = new Map<string, Set<string>>();
  const now = options.now ?? Date.now;

  async function prepare(input: {
    sessionId: string;
    query: string;
    generation: number;
    inject: boolean;
    recallEnabled: boolean;
    signal?: AbortSignal;
  }): Promise<PreparedManagedMemory> {
    const started = now();
    if (ignoreMemory(input.query)) {
      return { enabled: true, generation: input.generation, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: Math.max(0, now() - started) } };
    }
    const [index, candidates] = await Promise.all([
      options.store.readIndex(options.workspaceId),
      input.recallEnabled ? options.store.scan(options.workspaceId, input.signal) : Promise.resolve([]),
    ]);
    const surfaced = surfacedBySession.get(input.sessionId) ?? new Set<string>();
    let selectedPaths: string[] = [];
    let selector: PreparedManagedMemory['recall']['selector'] = 'none';
    let warning: string | undefined;
    if (input.recallEnabled && candidates.length > 0) {
      try {
        const valid = new Set(candidates.map((candidate) => candidate.path));
        selectedPaths = (await options.selector.select({ query: input.query, candidates, alreadySurfaced: surfaced, signal: input.signal }))
          .filter((path, indexValue, all) => valid.has(path) && all.indexOf(path) === indexValue)
          .slice(0, MANAGED_MEMORY_LIMITS.maxSelectedTopics);
        selector = 'model';
      } catch (error) {
        if (input.signal?.aborted) throw error;
        selectedPaths = lexicalSelect(input.query, candidates, surfaced);
        selector = 'lexical-fallback';
        warning = error instanceof Error ? error.message : String(error);
      }
    }
    const selected = await Promise.allSettled(selectedPaths.map((path) => options.store.readTopic(options.workspaceId, path, {
      maxLines: MANAGED_MEMORY_LIMITS.maxReadLines,
      maxBytes: MANAGED_MEMORY_LIMITS.maxTopicRecallBytes,
    })));
    const refs: ManagedMemoryContextRef[] = [];
    if (index) refs.push({ path: index.path, digest: index.digest, mtimeMs: index.mtimeMs, bytes: index.bytes, truncated: index.truncated, reason: 'index' });
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
      surfaced.add(`${topic.path}:${topic.digest}`);
    }
    surfacedBySession.set(input.sessionId, surfaced);
    const sections: ContextSection[] = input.inject ? [
      { source: 'systemPrompt', content: buildMemoryPolicyPrompt(candidates.length === 0) },
      { source: 'managedMemory', content: `## Managed Memory Index\n${index?.raw.trim() || '(empty)'}` },
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

  return { prepare, clearSession(sessionId: string) { surfacedBySession.delete(sessionId); }, clearAll() { surfacedBySession.clear(); } };
}
