import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MANAGED_MEMORY_SETTINGS,
  MANAGED_MEMORY_LIMITS,
  type ManagedMemoryActor,
  type ManagedMemoryOperation,
  type ManagedMemorySettings,
  type ManagedMemorySettingsPatch,
  type MemoryFileView,
  type MemoryHeader,
  type MemoryMutationResult,
  type MemoryRemoveInput,
  type MemoryTopic,
  type MemoryUpsertInput,
} from './contracts.ts';
import {
  ManagedMemoryValidationError,
  assertNoHighConfidenceSecret,
  indexEntry,
  parseTopic,
  removeIndexEntry,
  serializeTopic,
  sha256,
  truncateIndexForRead,
  truncateUtf8AtLine,
  upsertIndexEntry,
  utf8Bytes,
  validateIndexForWrite,
} from './format.ts';
import { assertNoSymlink, createManagedMemoryPaths, resolveContained, validateTopicPath } from './paths.ts';

const EMPTY_INDEX = '# Managed Memory\n';

type RecoveryIntent = {
  version: 1;
  operation: ManagedMemoryOperation;
  topicPath: string;
  topicContent: string | null;
  indexContent: string;
};

type StoreOptions = {
  workspaceId: string;
  workspaceStateDir: string;
  clock?: () => Date;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ENOENT';
}

export function createManagedMemoryStore(options: StoreOptions) {
  const paths = createManagedMemoryPaths(options.workspaceStateDir);
  const clock = options.clock ?? (() => new Date());
  let mutationTail = Promise.resolve();
  let ensured: Promise<void> | undefined;
  const operations = new Map<string, ManagedMemoryOperation>();
  const diagnostics = new Set<string>();
  let degraded = false;

  function assertWorkspace(workspaceId: string) {
    if (workspaceId !== options.workspaceId) throw new ManagedMemoryValidationError('Workspace binding mismatch');
  }

  async function atomicWrite(target: string, content: string, operationId: string = crypto.randomUUID()): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}.tmp`;
    await writeFile(temp, content, 'utf8');
    try {
      await rename(temp, target);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      await rm(target, { force: true });
      await rename(temp, target);
    }
  }

  async function appendOperation(operation: ManagedMemoryOperation): Promise<void> {
    await appendFile(paths.operations, `${JSON.stringify(operation)}\n`, 'utf8');
    operations.set(operation.operationId, operation);
  }

  async function loadOperations(): Promise<void> {
    operations.clear();
    try {
      const raw = await readFile(paths.operations, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const operation = JSON.parse(line) as ManagedMemoryOperation;
          if (operation?.version === 1 && typeof operation.operationId === 'string') operations.set(operation.operationId, operation);
        } catch {
          diagnostics.add('operations journal contains an invalid record');
        }
      }
    } catch (error) {
      if (!isNotFound(error)) diagnostics.add(`operations journal unreadable: ${errorMessage(error)}`);
    }
  }

  async function recover(): Promise<void> {
    let intent: RecoveryIntent;
    try {
      intent = JSON.parse(await readFile(paths.recovery, 'utf8')) as RecoveryIntent;
    } catch (error) {
      if (!isNotFound(error)) {
        degraded = true;
        diagnostics.add(`recovery intent unreadable: ${errorMessage(error)}`);
      }
      return;
    }
    if (intent.version !== 1 || intent.operation.workspaceId !== options.workspaceId) {
      degraded = true;
      diagnostics.add('recovery intent has an invalid workspace binding');
      return;
    }
    try {
      const topicPath = resolveContained(paths.root, validateTopicPath(intent.topicPath));
      await assertNoSymlink(topicPath);
      if (intent.topicContent === null) await rm(topicPath, { force: true });
      else await atomicWrite(topicPath, intent.topicContent, intent.operation.operationId);
      await atomicWrite(paths.index, validateIndexForWrite(intent.indexContent), intent.operation.operationId);
      if (!operations.has(intent.operation.operationId)) await appendOperation(intent.operation);
      await rm(paths.recovery, { force: true });
    } catch (error) {
      degraded = true;
      diagnostics.add(`recovery failed: ${errorMessage(error)}`);
    }
  }

  async function ensure(): Promise<void> {
    if (!ensured) ensured = (async () => {
      await mkdir(paths.state, { recursive: true });
      await assertNoSymlink(paths.root, false);
      await assertNoSymlink(paths.state, false);
      try { await stat(paths.index); } catch (error) { if (isNotFound(error)) await atomicWrite(paths.index, EMPTY_INDEX, 'initialize'); else throw error; }
      await loadOperations();
      await recover();
    })().catch((error) => { ensured = undefined; throw error; });
    await ensured;
  }

  function withMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(action, action);
    mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function rawIndex(): Promise<string> {
    await ensure();
    try { return await readFile(paths.index, 'utf8'); } catch (error) { if (isNotFound(error)) return EMPTY_INDEX; throw error; }
  }

  async function readIndex(workspaceId: string): Promise<MemoryFileView | null> {
    assertWorkspace(workspaceId);
    await ensure();
    try {
      const raw = await readFile(paths.index, 'utf8');
      const info = await stat(paths.index);
      const truncated = truncateIndexForRead(raw);
      if (truncated.warning) diagnostics.add(truncated.warning);
      return {
        path: 'MEMORY.md', raw: truncated.content, digest: sha256(raw), mtimeMs: info.mtimeMs,
        bytes: utf8Bytes(raw), truncated: truncated.truncated, ...(truncated.warning ? { warning: truncated.warning } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function headerFor(path: string): Promise<MemoryHeader> {
    const absolute = resolveContained(paths.root, validateTopicPath(path));
    await assertNoSymlink(absolute, false);
    const [raw, info] = await Promise.all([readFile(absolute, 'utf8'), stat(absolute)]);
    const parsed = parseTopic(raw.split('\n').slice(0, MANAGED_MEMORY_LIMITS.frontmatterLines + 2).join('\n') + '\n');
    return {
      path, name: parsed.name, description: parsed.description, type: parsed.type,
      mtimeMs: info.mtimeMs, bytes: utf8Bytes(raw), digest: sha256(raw),
    };
  }

  async function scan(workspaceId: string, signal?: AbortSignal): Promise<MemoryHeader[]> {
    assertWorkspace(workspaceId);
    await ensure();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let entries: Dirent[];
    try { entries = await readdir(paths.root, { withFileTypes: true }) as Dirent[]; } catch (error) { if (isNotFound(error)) return []; throw error; }
    const candidates = entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name !== 'MEMORY.md' && !entry.name.startsWith('.') && entry.name.endsWith('.md'))
      .slice(0, MANAGED_MEMORY_LIMITS.maxTopics * 2);
    const settled = await Promise.allSettled(candidates.map((entry) => headerFor(entry.name)));
    for (const item of settled) if (item.status === 'rejected') diagnostics.add(`topic excluded: ${errorMessage(item.reason)}`);
    return settled
      .filter((item): item is PromiseFulfilledResult<MemoryHeader> => item.status === 'fulfilled')
      .map((item) => item.value)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, MANAGED_MEMORY_LIMITS.maxTopics);
  }

  async function readTopic(workspaceId: string, pathInput: string, limits: { offset?: number; maxLines?: number; maxBytes?: number } = {}): Promise<MemoryTopic> {
    assertWorkspace(workspaceId);
    await ensure();
    const path = validateTopicPath(pathInput);
    const absolute = resolveContained(paths.root, path);
    await assertNoSymlink(absolute, false);
    const [raw, info] = await Promise.all([readFile(absolute, 'utf8'), stat(absolute)]);
    const parsed = parseTopic(raw);
    const offset = Math.max(0, Math.floor(limits.offset ?? 0));
    const remaining = raw.slice(offset);
    const view = truncateUtf8AtLine(
      remaining,
      Math.min(MANAGED_MEMORY_LIMITS.maxReadLines, Math.max(1, limits.maxLines ?? MANAGED_MEMORY_LIMITS.maxReadLines)),
      Math.min(MANAGED_MEMORY_LIMITS.maxReadBytes, Math.max(1, limits.maxBytes ?? MANAGED_MEMORY_LIMITS.maxReadBytes)),
    );
    return {
      path, name: parsed.name, description: parsed.description, type: parsed.type, body: parsed.body,
      raw: view.content, digest: sha256(raw), mtimeMs: info.mtimeMs, bytes: utf8Bytes(raw),
      truncated: view.truncated || offset > 0, offset,
      ...(offset + view.content.length < raw.length ? { nextOffset: offset + view.content.length } : {}),
    };
  }

  function replay(operation: ManagedMemoryOperation): MemoryMutationResult {
    return {
      ok: operation.outcome === 'committed', mutationCommitted: operation.outcome === 'committed', action: operation.action as 'upsert' | 'remove',
      path: operation.path ?? '', operationId: operation.operationId, ...(operation.afterDigest ? { digest: operation.afterDigest } : {}), replayed: true,
      ...(operation.outcome !== 'committed' ? { error: operation.reason ?? operation.outcome } : {}),
    };
  }

  async function settings(): Promise<ManagedMemorySettings> {
    await ensure();
    try {
      const parsed = JSON.parse(await readFile(paths.settings, 'utf8')) as Partial<ManagedMemorySettings>;
      return { ...DEFAULT_MANAGED_MEMORY_SETTINGS, ...parsed, version: 1, generation: Number.isInteger(parsed.generation) ? parsed.generation! : 0 };
    } catch (error) {
      if (!isNotFound(error)) diagnostics.add(`settings unreadable: ${errorMessage(error)}`);
      return { ...DEFAULT_MANAGED_MEMORY_SETTINGS };
    }
  }

  async function validateGeneration(expectedGeneration: number | undefined): Promise<MemoryMutationResult | undefined> {
    if (expectedGeneration === undefined) return undefined;
    const current = await settings();
    if (current.generation === expectedGeneration) return undefined;
    return { ok: false, mutationCommitted: false, action: 'upsert', path: '', operationId: '', code: 'MEMORY_GENERATION_CHANGED', error: 'Memory generation changed; the stale task may not commit' };
  }

  async function recordRejected(input: MemoryUpsertInput | MemoryRemoveInput, action: 'upsert' | 'remove', error: unknown): Promise<MemoryMutationResult> {
    const operation: ManagedMemoryOperation = {
      version: 1, operationId: input.operationId, workspaceId: options.workspaceId, at: clock().toISOString(), actor: input.actor,
      action, path: input.path, ...(input.runId ? { runId: input.runId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      outcome: error instanceof ManagedMemoryValidationError ? 'rejected' : 'failed', reason: errorMessage(error).slice(0, 500),
    };
    try { await appendOperation(operation); } catch { /* original error is more useful */ }
    return { ok: false, mutationCommitted: false, action, path: input.path, operationId: input.operationId, code: 'MEMORY_REJECTED', error: operation.reason };
  }

  async function upsert(input: MemoryUpsertInput): Promise<MemoryMutationResult> {
    assertWorkspace(input.workspaceId);
    return withMutation(async () => {
      await ensure();
      const prior = operations.get(input.operationId);
      if (prior) return replay(prior);
      try {
        if (degraded) throw new ManagedMemoryValidationError('Managed memory is degraded and read-only until recovery succeeds');
        const generationError = await validateGeneration(input.expectedGeneration);
        if (generationError) return { ...generationError, action: 'upsert', path: input.path, operationId: input.operationId };
        const path = validateTopicPath(input.path);
        const absolute = resolveContained(paths.root, path);
        await assertNoSymlink(absolute);
        assertNoHighConfidenceSecret(`${input.name}\n${input.description}\n${input.body}`);
        let beforeDigest: string | undefined;
        try { beforeDigest = sha256(await readFile(absolute, 'utf8')); } catch (error) { if (!isNotFound(error)) throw error; }
        if (beforeDigest) {
          if (!input.expectedDigest || input.expectedDigest !== beforeDigest) {
            const operation: ManagedMemoryOperation = {
              version: 1, operationId: input.operationId, workspaceId: options.workspaceId, at: clock().toISOString(), actor: input.actor,
              action: 'upsert', path, beforeDigest, outcome: 'conflict', reason: 'expectedDigest does not match current topic',
              ...(input.runId ? { runId: input.runId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            };
            await appendOperation(operation);
            return { ok: false, mutationCommitted: false, action: 'upsert', path, operationId: input.operationId, code: 'MEMORY_CONFLICT', latestDigest: beforeDigest, error: operation.reason };
          }
        } else if (input.expectedDigest !== null) {
          throw new ManagedMemoryValidationError('New topic requires expectedDigest: null');
        }
        const topicContent = serializeTopic(input);
        const afterDigest = sha256(topicContent);
        const nextIndex = upsertIndexEntry(await rawIndex(), path, indexEntry(path, input.indexTitle, input.indexHook));
        const operation: ManagedMemoryOperation = {
          version: 1, operationId: input.operationId, workspaceId: options.workspaceId, at: clock().toISOString(), actor: input.actor,
          action: 'upsert', path, ...(beforeDigest ? { beforeDigest } : {}), afterDigest, outcome: 'committed',
          ...(input.runId ? { runId: input.runId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        };
        const intent: RecoveryIntent = { version: 1, operation, topicPath: path, topicContent, indexContent: nextIndex };
        await atomicWrite(paths.recovery, JSON.stringify(intent, null, 2) + '\n', input.operationId);
        await atomicWrite(absolute, topicContent, input.operationId);
        await atomicWrite(paths.index, nextIndex, input.operationId);
        await appendOperation(operation);
        await rm(paths.recovery, { force: true });
        return { ok: true, mutationCommitted: true, action: 'upsert', path, operationId: input.operationId, digest: afterDigest, indexDigest: sha256(nextIndex) };
      } catch (error) {
        return recordRejected(input, 'upsert', error);
      }
    });
  }

  async function remove(input: MemoryRemoveInput): Promise<MemoryMutationResult> {
    assertWorkspace(input.workspaceId);
    return withMutation(async () => {
      await ensure();
      const prior = operations.get(input.operationId);
      if (prior) return replay(prior);
      try {
        if (degraded) throw new ManagedMemoryValidationError('Managed memory is degraded and read-only until recovery succeeds');
        const currentSettings = await settings();
        if (input.expectedGeneration !== undefined && currentSettings.generation !== input.expectedGeneration) {
          return { ok: false, mutationCommitted: false, action: 'remove', path: input.path, operationId: input.operationId, code: 'MEMORY_GENERATION_CHANGED', error: 'Memory generation changed; the stale task may not commit' };
        }
        const path = validateTopicPath(input.path);
        const absolute = resolveContained(paths.root, path);
        await assertNoSymlink(absolute, false);
        const beforeDigest = sha256(await readFile(absolute, 'utf8'));
        if (input.expectedDigest !== beforeDigest) {
          const operation: ManagedMemoryOperation = {
            version: 1, operationId: input.operationId, workspaceId: options.workspaceId, at: clock().toISOString(), actor: input.actor,
            action: 'remove', path, beforeDigest, outcome: 'conflict', reason: 'expectedDigest does not match current topic',
            ...(input.runId ? { runId: input.runId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          };
          await appendOperation(operation);
          return { ok: false, mutationCommitted: false, action: 'remove', path, operationId: input.operationId, code: 'MEMORY_CONFLICT', latestDigest: beforeDigest, error: operation.reason };
        }
        const nextIndex = removeIndexEntry(await rawIndex(), path);
        const operation: ManagedMemoryOperation = {
          version: 1, operationId: input.operationId, workspaceId: options.workspaceId, at: clock().toISOString(), actor: input.actor,
          action: 'remove', path, beforeDigest, outcome: 'committed', reason: input.reason.slice(0, 500),
          ...(input.runId ? { runId: input.runId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        };
        const intent: RecoveryIntent = { version: 1, operation, topicPath: path, topicContent: null, indexContent: nextIndex };
        await atomicWrite(paths.recovery, JSON.stringify(intent, null, 2) + '\n', input.operationId);
        await rm(absolute, { force: true });
        await atomicWrite(paths.index, nextIndex, input.operationId);
        await appendOperation(operation);
        await rm(paths.recovery, { force: true });
        return { ok: true, mutationCommitted: true, action: 'remove', path, operationId: input.operationId, indexDigest: sha256(nextIndex) };
      } catch (error) {
        return recordRejected(input, 'remove', error);
      }
    });
  }

  async function search(workspaceId: string, queryInput: string, type?: string, maxResults = 20) {
    assertWorkspace(workspaceId);
    const query = queryInput.trim().toLowerCase();
    if (!query) return [];
    const headers = await scan(workspaceId);
    const results: Array<{ path: string; name: string; type: string; line: number; snippet: string; digest: string }> = [];
    for (const header of headers) {
      if (type && header.type !== type) continue;
      try {
        const raw = await readFile(resolveContained(paths.root, header.path), 'utf8');
        const lines = raw.split('\n');
        const line = lines.findIndex((value) => value.toLowerCase().includes(query));
        if (line >= 0) results.push({ path: header.path, name: header.name, type: header.type, line: line + 1, snippet: lines[line]!.slice(0, 240), digest: header.digest });
      } catch { /* scan diagnostics already expose bad files */ }
      if (results.length >= Math.min(MANAGED_MEMORY_LIMITS.maxSearchResults, Math.max(1, maxResults))) break;
    }
    return results;
  }

  async function updateSettings(workspaceId: string, patch: ManagedMemorySettingsPatch): Promise<ManagedMemorySettings> {
    assertWorkspace(workspaceId);
    return withMutation(async () => {
      const current = await settings();
      const next = {
        ...current,
        ...patch,
        version: 1 as const,
        generation: patch.enabled !== undefined && patch.enabled !== current.enabled ? current.generation + 1 : current.generation,
      };
      for (const key of ['extractionEveryCompletedRuns', 'consolidationMinHours', 'consolidationMinSessions'] as const) {
        if (!Number.isFinite(next[key]) || next[key] <= 0) throw new ManagedMemoryValidationError(`${key} must be positive`);
      }
      await atomicWrite(paths.settings, JSON.stringify(next, null, 2) + '\n', `settings-${crypto.randomUUID()}`);
      await appendOperation({ version: 1, operationId: crypto.randomUUID(), workspaceId, at: clock().toISOString(), actor: 'user', action: 'settings', outcome: 'committed' });
      return next;
    });
  }

  async function rebuildIndex(workspaceId: string): Promise<{ topicCount: number; digest: string }> {
    assertWorkspace(workspaceId);
    return withMutation(async () => {
      const headers = await scan(workspaceId);
      let index = EMPTY_INDEX;
      for (const header of [...headers].reverse()) {
        index = upsertIndexEntry(index, header.path, indexEntry(header.path, header.name, header.description));
      }
      await atomicWrite(paths.index, index, `rebuild-${crypto.randomUUID()}`);
      return { topicCount: headers.length, digest: sha256(index) };
    });
  }

  async function clear(workspaceId: string): Promise<{ deletedFiles: number; releasedBytes: number; generation: number }> {
    assertWorkspace(workspaceId);
    return withMutation(async () => {
      await ensure();
      const current = await settings();
      let deletedFiles = 0;
      let releasedBytes = 0;
      const entries = await readdir(paths.root, { withFileTypes: true }) as Dirent[];
      for (const entry of entries) {
        if (entry.name === '.state' || (!entry.isFile() && !entry.isSymbolicLink())) continue;
        const target = join(paths.root, entry.name);
        try { const info = await stat(target); releasedBytes += info.size; } catch { /* best effort accounting */ }
        await rm(target, { force: true });
        deletedFiles += 1;
      }
      for (const target of [paths.checkpoints, paths.operations, paths.recovery, paths.consolidation]) {
        try { const info = await stat(target); releasedBytes += info.size; deletedFiles += 1; } catch { /* absent */ }
        await rm(target, { force: true });
      }
      const next = { ...current, generation: current.generation + 1 };
      await atomicWrite(paths.settings, JSON.stringify(next, null, 2) + '\n', `clear-${next.generation}`);
      await atomicWrite(paths.index, EMPTY_INDEX, `clear-${next.generation}`);
      operations.clear();
      degraded = false;
      diagnostics.clear();
      return { deletedFiles, releasedBytes, generation: next.generation };
    });
  }

  return {
    paths,
    ensure,
    readIndex,
    scan,
    readTopic,
    search,
    upsert,
    remove,
    settings,
    updateSettings,
    rebuildIndex,
    clear,
    diagnostics: () => ({ degraded, messages: [...diagnostics] }),
    withMutation,
  };
}

export type ManagedMemoryStore = ReturnType<typeof createManagedMemoryStore>;
