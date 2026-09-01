import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyAgentStoreEvent, createAgentTreeSnapshot } from './agent-journal-reducer.ts';
import { createHash } from 'node:crypto';
import type { AgentCompletionNotification, AgentRecord, AgentRunRecord, AgentStoreEvent, AgentTreeSnapshot } from './contracts.ts';

type Header = { version: 1; type: 'agent_tree_header'; sessionId: string; rootAgentId: string; createdAt: string };
type Commit = { version: 1; type: 'agent_commit'; sessionId: string; revision: number; at: string; events: AgentStoreEvent[] };

function validSessionId(id: string): string {
  if (!/^session-[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid session id');
  return id;
}

export function createAgentStore(options: { sessionsDir: string; observe?: (sessionId: string, events: AgentStoreEvent[], snapshot: AgentTreeSnapshot) => void }) {
  const locks = new Map<string, Promise<void>>();
  const cache = new Map<string, AgentTreeSnapshot>();
  const pathFor = (sessionId: string) => {
    const id = validSessionId(sessionId);
    const shard = id.slice('session-'.length, 'session-'.length + 2).toLowerCase().padEnd(2, '_');
    return join(options.sessionsDir, shard, id, 'agents.jsonl');
  };
  const withLock = async <T>(sessionId: string, action: () => Promise<T>): Promise<T> => {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(sessionId, queued);
    await previous;
    try { return await action(); } finally { release(); if (locks.get(sessionId) === queued) locks.delete(sessionId); }
  };
  const publish = async (path: string, content: string) => {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  };

  async function loadRaw(sessionId: string): Promise<AgentTreeSnapshot | null> {
    const cached = cache.get(sessionId);
    if (cached) return structuredClone(cached);
    const path = pathFor(sessionId);
    let content: string;
    try { content = await readFile(path, 'utf8'); } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
    const terminated = content.endsWith('\n');
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let header: Header;
    try { header = JSON.parse(lines[0] ?? '') as Header; } catch { throw new Error(`Invalid Agent journal header: ${path}`); }
    if (header.version !== 1 || header.type !== 'agent_tree_header' || header.sessionId !== sessionId) throw new Error(`Invalid Agent journal header: ${path}`);
    const snapshot = createAgentTreeSnapshot(sessionId, header.rootAgentId);
    for (let index = 1; index < lines.length; index += 1) {
      let commit: Commit;
      try { commit = JSON.parse(lines[index]!) as Commit; } catch (error) {
        if (index === lines.length - 1 && !terminated) {
          const prefix = `${lines.slice(0, index).join('\n')}\n`;
          await publish(path, prefix);
          cache.set(sessionId, structuredClone(snapshot));
          return structuredClone(snapshot);
        }
        throw new Error(`Invalid Agent journal at ${path}:${index + 1}`, { cause: error });
      }
      if (commit.version !== 1 || commit.type !== 'agent_commit' || commit.sessionId !== sessionId || commit.revision !== snapshot.revision + 1 || !Array.isArray(commit.events)) {
        throw new Error(`Invalid Agent journal commit at ${path}:${index + 1}`);
      }
      for (const event of commit.events) applyAgentStoreEvent(snapshot, event);
      snapshot.revision = commit.revision;
    }
    if (!terminated) await appendFile(path, '\n', { encoding: 'utf8', mode: 0o600 });
    cache.set(sessionId, structuredClone(snapshot));
    return structuredClone(snapshot);
  }

  async function ensure(sessionId: string, rootAgentId = `agent-root-${sessionId.slice('session-'.length)}`): Promise<AgentTreeSnapshot> {
    const existing = await loadRaw(sessionId);
    if (existing) return existing;
    const header: Header = { version: 1, type: 'agent_tree_header', sessionId, rootAgentId, createdAt: new Date().toISOString() };
    const path = pathFor(sessionId);
    await mkdir(dirname(path), { recursive: true });
    try { await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      return (await loadRaw(sessionId))!;
    }
    const snapshot = createAgentTreeSnapshot(sessionId, rootAgentId);
    cache.set(sessionId, structuredClone(snapshot));
    return snapshot;
  }

  async function append(sessionId: string, events: AgentStoreEvent[], optionsAppend: { create?: boolean } = {}): Promise<AgentTreeSnapshot> {
    return withLock(sessionId, async () => {
      cache.delete(sessionId);
      const snapshot = optionsAppend.create ? await ensure(sessionId) : await loadRaw(sessionId);
      if (!snapshot) throw new Error(`Agent tree not found for Session: ${sessionId}`);
      const commit: Commit = { version: 1, type: 'agent_commit', sessionId, revision: snapshot.revision + 1, at: new Date().toISOString(), events };
      for (const event of events) applyAgentStoreEvent(snapshot, event);
      snapshot.revision = commit.revision;
      await appendFile(pathFor(sessionId), `${JSON.stringify(commit)}\n`, { encoding: 'utf8', mode: 0o600 });
      cache.set(sessionId, structuredClone(snapshot));
      options.observe?.(sessionId, structuredClone(events), structuredClone(snapshot));
      return structuredClone(snapshot);
    });
  }

  async function load(sessionId: string, recover = true): Promise<AgentTreeSnapshot | null> {
    return withLock(sessionId, async () => {
      cache.delete(sessionId);
      let snapshot = await loadRaw(sessionId);
      if (!snapshot || !recover) return snapshot;
      const running = snapshot.runs.filter((run) => run.status === 'running');
      if (running.length === 0) return snapshot;
      const completedAt = new Date().toISOString();
      const events: AgentStoreEvent[] = running.flatMap((run) => {
        const notification: AgentCompletionNotification = {
          notificationId: `notification-${run.agentRunId}`,
          agentId: run.agentId,
          agentRunId: run.agentRunId,
          ...(run.delegationGroupId ? { delegationGroupId: run.delegationGroupId } : {}),
          createdAt: completedAt,
          status: 'pending',
          summary: 'Child agent run was interrupted by process restart.',
          result: { status: 'interrupted', terminationReason: 'recovered_interruption', finalContent: '', error: { code: 'RUN_INTERRUPTED', message: 'Agent Run was interrupted by process restart' } },
        };
        return [
          { type: 'agent_recovered', agentId: run.agentId, agentRunId: run.agentRunId, completedAt },
          { type: 'agent_completion_notification', notification },
        ];
      });
      const commit: Commit = { version: 1, type: 'agent_commit', sessionId, revision: snapshot!.revision + 1, at: completedAt, events };
      for (const event of events) applyAgentStoreEvent(snapshot!, event);
      snapshot!.revision = commit.revision;
      await appendFile(pathFor(sessionId), `${JSON.stringify(commit)}\n`, { encoding: 'utf8', mode: 0o600 });
      cache.set(sessionId, structuredClone(snapshot));
      options.observe?.(sessionId, structuredClone(events), structuredClone(snapshot));
      return structuredClone(snapshot);
    });
  }

  const createAgentRun = (sessionId: string, agent: AgentRecord, run: AgentRunRecord, operationId: string) => append(sessionId, [
    { type: 'agent_created', agent, operationId },
    { type: 'agent_run_started', run, operationId },
    { type: 'agent_context_committed', context: {
      owner: { kind: 'agent', sessionId, agentId: agent.agentId }, agentRunId: run.agentRunId, mode: agent.contextMode,
      seedMessageCount: agent.contextSeed.length,
      seedDigest: `sha256-${createHash('sha256').update(JSON.stringify(agent.contextSeed)).digest('hex')}`,
      committedAt: run.startedAt,
    } },
    { type: 'agent_message_committed', agentId: agent.agentId, agentRunId: run.agentRunId, message: { role: 'user', content: run.input } },
  ], { create: true });

  async function pendingNotifications(sessionId: string): Promise<AgentCompletionNotification[]> {
    const snapshot = await load(sessionId, false);
    if (snapshot?.control.halted) return [];
    return snapshot?.inbox.filter((item) => item.status === 'pending') ?? [];
  }

  async function consumeNotifications(sessionId: string, notificationIds: string[], consumedByRunId: string): Promise<AgentTreeSnapshot | null> {
    if (notificationIds.length === 0) return load(sessionId, false);
    return append(sessionId, [{
      type: 'agent_completion_consumed', notificationIds: [...new Set(notificationIds)], consumedAt: new Date().toISOString(), consumedByRunId,
    }]);
  }

  async function haltSession(sessionId: string, reason: string): Promise<AgentTreeSnapshot | null> {
    const snapshot = await load(sessionId, false);
    if (!snapshot) return null;
    if (snapshot.control.halted && snapshot.control.haltedReason === reason) return snapshot;
    return append(sessionId, [{ type: 'agent_session_halted', haltedAt: new Date().toISOString(), reason }]);
  }

  async function resumeSession(sessionId: string): Promise<AgentTreeSnapshot | null> {
    const snapshot = await load(sessionId, false);
    if (!snapshot || !snapshot.control.halted) return snapshot;
    return append(sessionId, [{ type: 'agent_session_resumed', resumedAt: new Date().toISOString() }]);
  }

  return {
    pathFor,
    exists: async (sessionId: string) => (await loadRaw(sessionId)) !== null,
    load,
    loadRaw,
    append,
    createAgentRun,
    pendingNotifications,
    consumeNotifications,
    haltSession,
    resumeSession,
    remove: async (sessionId: string) => { cache.delete(sessionId); await rm(pathFor(sessionId), { force: true }); },
  };
}

export type AgentStore = ReturnType<typeof createAgentStore>;
